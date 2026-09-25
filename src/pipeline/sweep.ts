// The periodic sweep (E-13): the backstop for work a lost message or a crash
// left behind. Everything it does is safe to repeat.
//
// - A processing document whose pages and tasks have all settled, but whose
//   counters say otherwise (or whose advance was lost), is advanced.
// - Keys with waiting documents and free slots are admitted.
import { admitNext } from "./admit.ts";
import { startAdvance, type PipelineDeps } from "./deps.ts";

export const SWEEP_QUEUE = "pipeline.sweep";

export interface SweepReport {
  advanced: number;
  admittedKeys: number;
}

export async function sweep(deps: PipelineDeps): Promise<SweepReport> {
  const settled = await deps.db.query<{ id: string }>(
    `SELECT d.id FROM documents d
     WHERE d.status = 'processing'
       AND NOT EXISTS (SELECT 1 FROM pages p WHERE p.document_id = d.id AND p.state = 'pending')
       AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.document_id = d.id AND t.state = 'pending')`,
  );
  for (const { id } of settled.rows) {
    await deps.db.transaction(async (tx) => {
      await tx.query(
        "UPDATE documents SET pages_pending = 0, tasks_pending = 0 WHERE id = $1",
        [id],
      );
      await startAdvance(deps.boss, tx, id);
    });
  }

  const waiting = await deps.db.query<{ api_key_id: string }>(
    `SELECT DISTINCT api_key_id FROM documents
     WHERE status = 'queued' OR (status = 'awaiting_offset' AND offset_confirmed_at IS NOT NULL)`,
  );
  for (const { api_key_id } of waiting.rows) await admitNext(deps, api_key_id);

  return { advanced: settled.rows.length, admittedKeys: waiting.rows.length };
}
