// Saving review's fixes (E-18): the changes and the result they make become
// the next revision; the earlier ones stay as they were. A new crop is cut
// for this revision, so the original stays in revision 1. The webhook fires
// with the new revision number. Review never blocks webhooks or exports: an
// untouched document is simply at revision 1.
import type { PgBoss } from "pg-boss";
import { indexTree } from "../assembly/tree-index.ts";
import type { Change } from "../contract/revision.ts";
import type { DocumentRow } from "../documents/store.ts";
import { pdfToPrinted } from "../offset/segments.ts";
import { getOutline } from "../outline/store.ts";
import { cutCrops } from "../pipeline/crops.ts";
import type { PageReading } from "../reading/blocks.ts";
import type { Db } from "../shared/db/pool.ts";
import { Refusal } from "../shared/refusal.ts";
import type { BlobStore } from "../storage/store.ts";
import { enqueueWebhook } from "../webhooks/deliver.ts";
import { applyChanges } from "./changes.ts";

const REVIEWABLE = new Set(["completed", "completed_with_errors"]);

export interface ReviseDeps {
  db: Db;
  boss: PgBoss;
  store: BlobStore;
}

/** Writes the next revision and returns its number. */
export async function reviseDocument(
  deps: ReviseDeps,
  orgId: string,
  documentId: string,
  base: number,
  changes: readonly Change[],
  author: string | null,
): Promise<number> {
  return deps.db.transaction(async (tx) => {
    // One save at a time per document: the next number is the latest + 1.
    const { rows } = await tx.query<DocumentRow>(
      "SELECT * FROM documents WHERE id = $1 AND org_id = $2 FOR UPDATE",
      [documentId, orgId],
    );
    const doc = rows[0];
    if (!doc) throw new Refusal("not_found", `No document ${documentId}.`);
    if (doc.expired_at !== null)
      throw new Refusal("gone", `Document ${documentId} has expired.`);
    if (!REVIEWABLE.has(doc.status)) {
      throw new Refusal(
        "wrong_state",
        `Document ${documentId} is ${doc.status}; it can be reviewed once it completes.`,
      );
    }
    const latest = await tx.query<{
      number: number;
      result: Parameters<typeof applyChanges>[0];
    }>(
      "SELECT number, result FROM revisions WHERE document_id = $1 ORDER BY number DESC LIMIT 1",
      [documentId],
    );
    const current = latest.rows[0];
    if (!current)
      throw new Refusal("wrong_state", `Document ${documentId} has no result.`);
    if (current.number !== base) {
      throw new Refusal(
        "wrong_state",
        `Document ${documentId} is at revision ${String(current.number)}, not ${String(base)}; reload it and make the changes again.`,
        { details: { revision: current.number } },
      );
    }

    const outline = await getOutline(tx, orgId, doc.outline_id);
    const readings = await tx.query<{ pdf_page: number; reading: PageReading }>(
      `SELECT pdf_page, reading FROM pages
       WHERE document_id = $1 AND pdf_page = ANY($2) AND reading IS NOT NULL`,
      [
        documentId,
        changes.flatMap((c) => (c.op === "place_block" ? [c.pdf_page] : [])),
      ],
    );
    const byPage = new Map(readings.rows.map((r) => [r.pdf_page, r.reading]));
    const result = applyChanges(current.result, changes, {
      tree: indexTree(outline?.nodes ?? []),
      block: (pdfPage, blockId) => {
        const block = byPage.get(pdfPage)?.blocks.find((b) => b.id === blockId);
        return block
          ? {
              block,
              locator: {
                pdf_page: pdfPage,
                printed_page: pdfToPrinted(doc.offset_segments ?? [], pdfPage),
              },
            }
          : null;
      },
    });

    const number = current.number + 1;
    // New crops are cut here, holding the document's lock; a crop cut for a
    // save that then fails is left unused under its revision's name.
    const failures = result.failures.length;
    await cutCrops({ db: tx, store: deps.store }, documentId, result, number);
    if (result.failures.length > failures) {
      throw new Refusal(
        "invalid_request",
        `A new crop couldn't be cut: ${result.failures.at(-1)?.detail ?? "unreadable"}. Nothing was saved.`,
      );
    }
    await tx.query(
      `INSERT INTO revisions (document_id, org_id, number, result, changes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        documentId,
        orgId,
        number,
        JSON.stringify(result),
        JSON.stringify(changes),
        author,
      ],
    );
    await tx.query("UPDATE documents SET revision = $2 WHERE id = $1", [
      documentId,
      number,
    ]);
    await enqueueWebhook(deps.boss, tx, {
      documentId,
      status: doc.status,
      revision: number,
    });
    return number;
  });
}
