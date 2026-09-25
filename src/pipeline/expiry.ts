// The 30-day expiry (spec #1 §6 lifetimes, E-14). Bucket lifecycle rules (E-02)
// delete the same objects as a safety net; this is what makes the API answer
// `410 gone` and keeps the database tidy.
//
// - A document past `expires_at` loses its page images, crops, results and
//   exports; its row stays as a tombstone (`expired_at`), so it answers 410.
// - A draft, or a confirmed outline no document used, is deleted at its expiry.
// - An upload no document used is deleted at its expiry (2 days).
import {
  TERMINAL_STATUSES,
  type DocumentStatus,
} from "../contract/document.ts";
import { sourceKeys, type DocumentSource } from "../documents/store.ts";
import { failDocument } from "./advance.ts";
import { removeOldLinks } from "../accounts/visits.ts";
import { IDEMPOTENCY_TTL_MS } from "../shared/limits.ts";
import type { PipelineDeps } from "./deps.ts";

export interface ExpiryReport {
  documents: number;
  outlines: number;
  uploads: number;
}

export async function expire(deps: PipelineDeps): Promise<ExpiryReport> {
  const now = deps.clock();

  const documents = await deps.db.query<{
    id: string;
    status: string;
    source: DocumentSource;
  }>(
    "SELECT id, status, source FROM documents WHERE expired_at IS NULL AND expires_at <= $1",
    [now],
  );
  for (const doc of documents.rows) {
    // A job still running at 30 days has gone wrong. It ends the usual way:
    // credits settled, webhook sent, book deleted, slot freed.
    if (!TERMINAL_STATUSES.includes(doc.status as DocumentStatus)) {
      await failDocument(
        deps,
        doc.id,
        "expired: the job did not finish within 30 days",
      );
    }
    await deps.store.deletePrefix(`pages/${doc.id}/`);
    await deps.store.deletePrefix(`results/${doc.id}/`);
    for (const key of sourceKeys(doc.source)) await deps.store.delete(key);
    await deps.db.transaction(async (tx) => {
      await tx.query("DELETE FROM revisions WHERE document_id = $1", [doc.id]);
      await tx.query("DELETE FROM tasks WHERE document_id = $1", [doc.id]);
      await tx.query("DELETE FROM pages WHERE document_id = $1", [doc.id]);
      await tx.query("UPDATE documents SET expired_at = $2 WHERE id = $1", [
        doc.id,
        now,
      ]);
    });
  }

  const outlines = await deps.db.query<{ id: string }>(
    "DELETE FROM outlines WHERE status IN ('draft', 'confirmed') AND expires_at <= $1 RETURNING id",
    [now],
  );
  // Their syllabus page images go with them.
  for (const { id } of outlines.rows) {
    await deps.store.deletePrefix(`pages/outlines/${id}/`);
  }

  const uploads = await deps.db.query<{ id: string; storage_key: string }>(
    "SELECT id, storage_key FROM uploads WHERE document_id IS NULL AND expires_at <= $1",
    [now],
  );
  for (const upload of uploads.rows) {
    await deps.store.delete(upload.storage_key);
    await deps.db.query("DELETE FROM uploads WHERE id = $1", [upload.id]);
  }

  await deps.db.query("DELETE FROM idempotency_keys WHERE created_at <= $1", [
    new Date(now.getTime() - IDEMPOTENCY_TTL_MS),
  ]);
  await removeOldLinks(deps.db, deps.clock);
  return {
    documents: documents.rows.length,
    outlines: outlines.rowCount ?? 0,
    uploads: uploads.rows.length,
  };
}
