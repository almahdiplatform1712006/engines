// The 30-day expiry (spec #1 §6 lifetimes, E-14). Bucket lifecycle rules (E-02)
// delete the same objects as a safety net; this is what makes the API answer
// `410 gone` and keeps the database tidy.
//
// - A document past `expires_at` loses its page images, crops, results and
//   exports; its row stays as a tombstone (`expired_at`), so it answers 410.
// - A draft, or a confirmed outline no document used, is deleted at its expiry.
// - An upload no document used is deleted at its expiry (2 days).
import type { PipelineDeps } from "./deps.ts";

export interface ExpiryReport {
  documents: number;
  outlines: number;
  uploads: number;
}

export async function expire(
  deps: Pick<PipelineDeps, "db" | "store" | "clock">,
): Promise<ExpiryReport> {
  const now = deps.clock();

  const documents = await deps.db.query<{ id: string }>(
    "SELECT id FROM documents WHERE expired_at IS NULL AND expires_at <= $1",
    [now],
  );
  for (const { id } of documents.rows) {
    await deps.store.deletePrefix(`pages/${id}/`);
    await deps.store.deletePrefix(`results/${id}/`);
    await deps.db.transaction(async (tx) => {
      await tx.query("DELETE FROM revisions WHERE document_id = $1", [id]);
      await tx.query("DELETE FROM tasks WHERE document_id = $1", [id]);
      await tx.query("DELETE FROM pages WHERE document_id = $1", [id]);
      // A job still running at 30 days has gone wrong; it ends as failed.
      await tx.query(
        `UPDATE documents SET expired_at = $2,
           status = CASE WHEN status IN ('completed', 'completed_with_errors', 'failed') THEN status ELSE 'failed' END
         WHERE id = $1`,
        [id, now],
      );
    });
  }

  const outlines = await deps.db.query(
    "DELETE FROM outlines WHERE status IN ('draft', 'confirmed') AND expires_at <= $1",
    [now],
  );

  const uploads = await deps.db.query<{ id: string; storage_key: string }>(
    "SELECT id, storage_key FROM uploads WHERE document_id IS NULL AND expires_at <= $1",
    [now],
  );
  for (const upload of uploads.rows) {
    await deps.store.delete(upload.storage_key);
    await deps.db.query("DELETE FROM uploads WHERE id = $1", [upload.id]);
  }

  await deps.db.query("DELETE FROM idempotency_keys WHERE created_at <= $1", [
    new Date(now.getTime() - 24 * 3600 * 1000),
  ]);
  return {
    documents: documents.rows.length,
    outlines: outlines.rowCount ?? 0,
    uploads: uploads.rows.length,
  };
}
