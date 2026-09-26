// Admission (E-13): how many documents a key runs at once.
//
// A document holds one of its key's slots while it renders and while it is
// read (`rendering`, `processing`), never while it waits for a person at
// `awaiting_offset`. `admit` fills free slots, confirmed offsets first (they
// were admitted once already), then queued documents, oldest first. It runs
// under a per-key advisory lock, so two admissions for one key never race.
import type { PgBoss } from "pg-boss";
import type { OffsetSegment } from "../offset/segments.ts";
import { lockApiKey } from "../shared/db/locks.ts";
import type { Db, Queryable } from "../shared/db/pool.ts";
import { Refusal } from "../shared/refusal.ts";
import {
  inTransaction,
  PAGE_READ_GROUP,
  queues,
  startAdvance,
  type DocumentJob,
  type PageJob,
} from "./deps.ts";

/** Seconds a caller is told to wait when its key's queue is full. */
export const RETRY_AFTER_SECONDS = 60;

async function lockKey(
  tx: Queryable,
  apiKeyId: string,
): Promise<{ concurrency: number; maxQueued: number }> {
  await lockApiKey(tx, apiKeyId);
  const { rows } = await tx.query<{ concurrency: number; max_queued: number }>(
    "SELECT concurrency, max_queued FROM api_keys WHERE id = $1",
    [apiKeyId],
  );
  const key = rows[0];
  if (!key) throw new Error(`api key ${apiKeyId} not found`);
  return { concurrency: key.concurrency, maxQueued: key.max_queued };
}

/**
 * Refuses a new document when its key's queue is full (`429 too_many_jobs`).
 * Runs in the create transaction and holds the key's lock until it commits.
 */
export async function checkQueueRoom(
  tx: Queryable,
  apiKeyId: string,
): Promise<void> {
  const { maxQueued } = await lockKey(tx, apiKeyId);
  const { rows } = await tx.query<{ waiting: number }>(
    "SELECT count(*)::int AS waiting FROM documents WHERE api_key_id = $1 AND status = 'queued'",
    [apiKeyId],
  );
  if ((rows[0]?.waiting ?? 0) >= maxQueued) {
    throw new Refusal(
      "too_many_jobs",
      `This key already has ${String(maxQueued)} documents waiting. Try again when some have started.`,
      { retryAfter: RETRY_AFTER_SECONDS },
    );
  }
}

/** Starts the key's waiting documents while it has free slots. Runs inside the caller's transaction. */
export async function admit(
  boss: PgBoss,
  tx: Queryable,
  apiKeyId: string,
): Promise<void> {
  const { concurrency } = await lockKey(tx, apiKeyId);
  const running = await tx.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM documents WHERE api_key_id = $1 AND status IN ('rendering', 'processing')",
    [apiKeyId],
  );
  let free = concurrency - (running.rows[0]?.n ?? 0);
  if (free <= 0) return;

  const confirmed = await tx.query<{
    id: string;
    offset_segments: OffsetSegment[];
  }>(
    `SELECT id, offset_segments FROM documents
     WHERE api_key_id = $1 AND status = 'awaiting_offset' AND offset_confirmed_at IS NOT NULL
     ORDER BY offset_confirmed_at LIMIT $2`,
    [apiKeyId, free],
  );
  for (const doc of confirmed.rows) {
    await startReading(boss, tx, doc.id, doc.offset_segments);
    free--;
  }
  if (free <= 0) return;

  const queued = await tx.query<{ id: string }>(
    `UPDATE documents SET status = 'rendering', started_at = now()
     WHERE id IN (
       SELECT id FROM documents WHERE api_key_id = $1 AND status = 'queued'
       ORDER BY created_at LIMIT $2
     )
     RETURNING id`,
    [apiKeyId, free],
  );
  for (const { id } of queued.rows) {
    await boss.send(queues.render, { documentId: id } satisfies DocumentJob, {
      db: inTransaction(tx),
    });
  }
}

/** `admit` in a transaction of its own: after a document ends or starts waiting for a person. */
export async function admitNext(
  deps: { db: Db; boss: PgBoss },
  apiKeyId: string,
): Promise<void> {
  await deps.db.transaction((tx) => admit(deps.boss, tx, apiKeyId));
}

/** The offset is confirmed and a slot is free: queue one read task per page (step 2). */
async function startReading(
  boss: PgBoss,
  tx: Queryable,
  documentId: string,
  segments: readonly OffsetSegment[],
): Promise<void> {
  const pending = await tx.query<{ pdf_page: number }>(
    "SELECT pdf_page FROM pages WHERE document_id = $1 AND state = 'pending' ORDER BY pdf_page",
    [documentId],
  );
  await tx.query(
    `UPDATE documents SET status = 'processing', pages_pending = $2, offset_segments = $3
     WHERE id = $1`,
    [documentId, pending.rows.length, JSON.stringify(segments)],
  );
  for (const { pdf_page } of pending.rows) {
    await boss.send(
      queues.readPage,
      { documentId, pdfPage: pdf_page } satisfies PageJob,
      { db: inTransaction(tx), group: PAGE_READ_GROUP },
    );
  }
  if (pending.rows.length === 0) await startAdvance(boss, tx, documentId);
}
