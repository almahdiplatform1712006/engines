// Admission: which queued documents start. E-05 admits everything; E-13 adds
// the per-key cap.
import type { PgBoss } from "pg-boss";
import type { Queryable } from "../shared/db/pool.ts";
import { inTransaction, queues, type DocumentJob } from "./deps.ts";

/** Starts the key's queued documents. Runs inside the caller's transaction. */
export async function admit(
  boss: PgBoss,
  tx: Queryable,
  apiKeyId: string,
): Promise<void> {
  const { rows } = await tx.query<{ id: string }>(
    `UPDATE documents SET status = 'rendering', started_at = now()
     WHERE id IN (
       SELECT id FROM documents WHERE api_key_id = $1 AND status = 'queued'
       ORDER BY created_at FOR UPDATE SKIP LOCKED
     )
     RETURNING id`,
    [apiKeyId],
  );
  for (const { id } of rows) {
    await boss.send(queues.render, { documentId: id } satisfies DocumentJob, {
      db: inTransaction(tx),
    });
  }
}
