// Step 2: one task per page, each reading one page image.
import type { PageReading } from "../reading/blocks.ts";
import { TruncatedOutputError } from "../reading/model.ts";
import type { Provider } from "../shared/config.ts";
import {
  messageOf,
  startAdvance,
  type PageJob,
  type PipelineDeps,
} from "./deps.ts";

/** Step 2: read one page, one image per call. A failure throws, so pg-boss retries this page alone. */
export async function readPage(
  deps: PipelineDeps,
  job: PageJob,
): Promise<void> {
  const { rows } = await deps.db.query<{
    image_key: string;
    state: string;
    org_id: string;
    provider: Provider;
  }>(
    `UPDATE pages p SET attempts = attempts + 1
     FROM documents d JOIN api_keys k ON k.id = d.api_key_id
     WHERE p.document_id = $1 AND p.pdf_page = $2 AND d.id = p.document_id
     RETURNING p.image_key, p.state, p.org_id, k.provider`,
    [job.documentId, job.pdfPage],
  );
  const page = rows[0];
  if (page?.state !== "pending") return;

  let reading: PageReading;
  try {
    const bytes = await deps.store.get(page.image_key);
    reading = await deps
      .reader(page.provider)
      .readPage(
        { pdfPage: job.pdfPage, bytes, mediaType: "image/png" },
        { orgId: page.org_id, documentId: job.documentId },
      );
  } catch (error) {
    const message = messageOf(error);
    // Output that never fits won't fit on a retry either: fail the page now.
    if (error instanceof TruncatedOutputError) {
      await settlePage(deps, job, { state: "failed", error: message });
      return;
    }
    await deps.db.query(
      "UPDATE pages SET error = $3 WHERE document_id = $1 AND pdf_page = $2",
      [job.documentId, job.pdfPage, message],
    );
    throw error;
  }
  await settlePage(deps, job, { state: "read", reading });
}

type PageOutcome =
  { state: "read"; reading: PageReading } | { state: "failed"; error: string };

/**
 * Records a page's outcome once (a redelivered task finds it settled and does
 * nothing) and counts the document's pending pages down in the same
 * transaction. Whoever settles the last page starts finish.
 */
export async function settlePage(
  deps: PipelineDeps,
  job: PageJob,
  outcome: PageOutcome,
): Promise<void> {
  await deps.db.transaction(async (tx) => {
    const settled = await tx.query(
      `UPDATE pages SET state = $3, reading = $4, printed_number = $5, error = $6
       WHERE document_id = $1 AND pdf_page = $2 AND state = 'pending'`,
      [
        job.documentId,
        job.pdfPage,
        outcome.state,
        outcome.state === "read" ? JSON.stringify(outcome.reading) : null,
        outcome.state === "read" ? outcome.reading.printed_number : null,
        outcome.state === "failed" ? outcome.error : null,
      ],
    );
    if (settled.rowCount !== 1) return;
    const { rows } = await tx.query<{ pages_pending: number }>(
      "UPDATE documents SET pages_pending = pages_pending - 1 WHERE id = $1 RETURNING pages_pending",
      [job.documentId],
    );
    if (rows[0]?.pages_pending === 0) {
      await startAdvance(deps.boss, tx, job.documentId);
    }
  });
}
