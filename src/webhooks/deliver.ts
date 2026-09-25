// Webhook delivery (spec #1 §3, E-13): `{ id, object, status, revision }` to the
// document's `webhook_url` when a job ends and when a review saves a revision,
// signed per organisation. Failed deliveries retry with backoff through
// pg-boss; every attempt is logged in `webhook_deliveries`.
import type { PgBoss } from "pg-boss";
import type { Db, Queryable } from "../shared/db/pool.ts";
import {
  newWebhookSecret,
  SIGNATURE_HEADER,
  signWebhook,
} from "./signature.ts";
import {
  assertPublicTarget,
  checkWebhookUrl,
  type TargetPolicy,
} from "./target.ts";

export const WEBHOOK_QUEUE = "webhook.deliver";
const TIMEOUT_MS = 10_000;

export interface WebhookJob {
  documentId: string;
  status: string;
  revision: number;
}

export interface WebhookPayload {
  id: string;
  object: "document";
  status: string;
  revision: number;
}

export async function createWebhookQueue(
  boss: PgBoss,
  retryDelay: number,
): Promise<void> {
  await boss.createQueue(WEBHOOK_QUEUE, {
    retryLimit: 8,
    retryDelay,
    retryBackoff: true,
    retryDelayMax: 3600,
    expireInSeconds: 60,
  });
}

/** Queues a delivery, in the caller's transaction, when the document has a webhook URL. */
export async function enqueueWebhook(
  boss: PgBoss,
  tx: Queryable,
  job: WebhookJob,
): Promise<void> {
  const { rows } = await tx.query<{ webhook_url: string | null }>(
    "SELECT webhook_url FROM documents WHERE id = $1",
    [job.documentId],
  );
  if (!rows[0]?.webhook_url) return;
  await boss.send(WEBHOOK_QUEUE, job, {
    db: {
      executeSql: (text: string, values?: unknown[]) => tx.query(text, values),
    },
  });
}

/** The organisation's signing secret, made on first use. */
export async function webhookSecret(
  db: Queryable,
  orgId: string,
): Promise<string> {
  const { rows } = await db.query<{ webhook_secret: string }>(
    `UPDATE organisations SET webhook_secret = COALESCE(webhook_secret, $2)
     WHERE id = $1 RETURNING webhook_secret`,
    [orgId, newWebhookSecret()],
  );
  const secret = rows[0]?.webhook_secret;
  if (!secret) throw new Error(`organisation ${orgId} not found`);
  return secret;
}

/** One delivery attempt. Throws on anything but a 2xx, so pg-boss retries it. */
export async function deliverWebhook(
  deps: { db: Db; clock: () => Date; webhooks: TargetPolicy },
  job: WebhookJob,
): Promise<void> {
  const { rows } = await deps.db.query<{
    org_id: string;
    webhook_url: string | null;
  }>("SELECT org_id, webhook_url FROM documents WHERE id = $1", [
    job.documentId,
  ]);
  const doc = rows[0];
  if (!doc?.webhook_url) return;

  const payload: WebhookPayload = {
    id: job.documentId,
    object: "document",
    status: job.status,
    revision: job.revision,
  };
  const body = JSON.stringify(payload);
  const secret = await webhookSecret(deps.db, doc.org_id);
  const { rows: previous } = await deps.db.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM webhook_deliveries WHERE document_id = $1 AND payload = $2",
    [job.documentId, body],
  );
  const attempt = (previous[0]?.n ?? 0) + 1;

  let statusCode: number | null = null;
  let error: string | null = null;
  try {
    const url = checkWebhookUrl(doc.webhook_url, deps.webhooks);
    await assertPublicTarget(url, deps.webhooks);
    const timestamp = Math.floor(deps.clock().getTime() / 1000);
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [SIGNATURE_HEADER]: signWebhook(secret, body, timestamp),
        "user-agent": "Engines-Webhooks/1",
      },
      body,
      // A redirect could point anywhere, private addresses included.
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    statusCode = response.status;
    await response.body?.cancel();
    if (response.status < 200 || response.status >= 300)
      error = `HTTP ${String(response.status)}`;
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }

  await deps.db.query(
    `INSERT INTO webhook_deliveries (org_id, document_id, url, payload, attempt, status_code, error)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      doc.org_id,
      job.documentId,
      doc.webhook_url,
      body,
      attempt,
      statusCode,
      error,
    ],
  );
  if (error !== null)
    throw new Error(`webhook delivery ${String(attempt)} failed: ${error}`);
}
