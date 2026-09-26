// Webhook delivery (spec #1 §3, E-13): `{ id, object, status, revision }` to the
// document's `webhook_url` when a job ends and when a review saves a revision,
// signed per organisation. Failed deliveries retry with backoff through
// pg-boss; every attempt is logged in `webhook_deliveries`.
// What a delivery POSTs is the contract's shape (src/contract/misc.ts).
import type { DocumentStatus } from "../contract/document.ts";
import type { WebhookPayload } from "../contract/misc.ts";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { PgBoss } from "pg-boss";
import { inTransaction } from "../shared/db/boss.ts";
import type { Db, Queryable } from "../shared/db/pool.ts";
import {
  newWebhookSecret,
  SIGNATURE_HEADER,
  signWebhook,
} from "./signature.ts";
import { checkWebhookUrl, pinnedLookup, type TargetPolicy } from "./target.ts";

export const WEBHOOK_QUEUE = "webhook.deliver";
const TIMEOUT_MS = 10_000;

export interface WebhookJob {
  documentId: string;
  status: DocumentStatus;
  revision: number;
}

export type { WebhookPayload };

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
    db: inTransaction(tx),
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

/**
 * One delivery attempt (`attempt` counts from 1). Throws on anything but a
 * 2xx, so pg-boss retries it.
 */
export async function deliverWebhook(
  deps: { db: Db; clock: () => Date; webhooks: TargetPolicy },
  job: WebhookJob,
  attempt: number,
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

  let statusCode: number | null = null;
  let error: string | null = null;
  try {
    const url = checkWebhookUrl(doc.webhook_url, deps.webhooks);
    const timestamp = Math.floor(deps.clock().getTime() / 1000);
    statusCode = await post(
      url,
      body,
      signWebhook(secret, body, timestamp),
      deps.webhooks,
    );
    if (statusCode < 200 || statusCode >= 300)
      error = `HTTP ${String(statusCode)}`;
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

/**
 * POSTs the body and returns the status code. Redirects aren't followed (a
 * redirect could point anywhere), and the connection goes to the address the
 * pinned lookup checked.
 */
function post(
  url: URL,
  body: string,
  signature: string,
  policy: TargetPolicy,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    const request = send(
      url,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          [SIGNATURE_HEADER]: signature,
          "user-agent": "Engines-Webhooks/1",
        },
        lookup: pinnedLookup(policy),
        timeout: TIMEOUT_MS,
      },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      },
    );
    request.on("timeout", () =>
      request.destroy(
        new Error(`no response in ${String(TIMEOUT_MS / 1000)} s`),
      ),
    );
    request.on("error", reject);
    request.end(body);
  });
}
