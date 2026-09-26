// `Idempotency-Key` on POST /v1/documents and /v1/outlines (spec #1 §2, E-13).
// A repeat within 24 hours with the same key and body returns the original
// response; the same key with a different body is refused (422). The key is
// claimed before the work runs, so two concurrent repeats can't both create.
import { createHash } from "node:crypto";
import type { Clock } from "../shared/clock.ts";
import { IDEMPOTENCY_TTL_MS } from "../shared/limits.ts";
import type { Queryable } from "../shared/db/pool.ts";
import { Refusal } from "../shared/refusal.ts";

export interface Stored {
  status: number;
  body: unknown;
  /** True when this is the stored response of an earlier request. */
  replayed?: boolean;
}

/** A claim with no response after this long belongs to a request that crashed. */
const ABANDONED_MS = 10 * 60 * 1000;

export const IDEMPOTENCY_HEADER = "idempotency-key";

export async function withIdempotency(
  db: Queryable,
  clock: Clock,
  request: {
    orgId: string;
    key: string | undefined;
    route: string;
    body: unknown;
  },
  run: () => Promise<Stored>,
): Promise<Stored> {
  const { orgId, key, route } = request;
  if (key === undefined) return run();
  if (key.length === 0 || key.length > 255) {
    throw new Refusal(
      "invalid_request",
      "Idempotency-Key must be 1–255 characters.",
    );
  }
  const hash = createHash("sha256")
    .update(`${route}\n${JSON.stringify(request.body)}`)
    .digest("hex");

  await db.query(
    "DELETE FROM idempotency_keys WHERE org_id = $1 AND key = $2 AND created_at < $3",
    [orgId, key, new Date(clock().getTime() - IDEMPOTENCY_TTL_MS)],
  );

  // Claim the key. If another request holds it: the same request finished
  // gives its response back; one still running is 409, unless it has been
  // silent so long it crashed, in which case this request takes over.
  for (let tries = 0; ; tries++) {
    const claimed = await db.query(
      `INSERT INTO idempotency_keys (org_id, key, route, request_hash, created_at)
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
      [orgId, key, route, hash, clock()],
    );
    if (claimed.rowCount === 1) break;
    const { rows } = await db.query<{
      request_hash: string;
      response_status: number | null;
      response_body: unknown;
      created_at: Date;
    }>(
      `SELECT request_hash, response_status, response_body, created_at
       FROM idempotency_keys WHERE org_id = $1 AND key = $2`,
      [orgId, key],
    );
    const existing = rows[0];
    // The holder was refused and let the key go: claim it again.
    if (!existing && tries < 3) continue;
    if (existing?.request_hash !== hash) {
      throw new Refusal(
        "idempotency_mismatch",
        "This Idempotency-Key was used with a different request in the last 24 hours.",
      );
    }
    if (existing.response_status !== null) {
      return {
        status: existing.response_status,
        body: existing.response_body,
        replayed: true,
      };
    }
    const abandoned =
      existing.created_at.getTime() < clock().getTime() - ABANDONED_MS;
    const taken = abandoned
      ? await db.query(
          `UPDATE idempotency_keys SET created_at = $3
           WHERE org_id = $1 AND key = $2 AND response_status IS NULL AND created_at = $4`,
          [orgId, key, clock(), existing.created_at],
        )
      : { rowCount: 0 };
    if (taken.rowCount === 1) break;
    throw new Refusal(
      "wrong_state",
      "A request with this Idempotency-Key is still in progress.",
    );
  }

  try {
    const response = await run();
    await db.query(
      "UPDATE idempotency_keys SET response_status = $3, response_body = $4 WHERE org_id = $1 AND key = $2",
      [orgId, key, response.status, JSON.stringify(response.body)],
    );
    return response;
  } catch (error) {
    // A refused request isn't remembered: the caller may fix it and retry with the same key.
    await db.query(
      "DELETE FROM idempotency_keys WHERE org_id = $1 AND key = $2",
      [orgId, key],
    );
    throw error;
  }
}
