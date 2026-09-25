// The offset confirmation (E-07): the uploader accepts or corrects the proposed
// segments, and the full read starts.
import { segmentProblems, type OffsetSegment } from "../offset/segments.ts";
import type { Queryable } from "../shared/db/pool.ts";
import { Refusal } from "../shared/refusal.ts";
import {
  inTransaction,
  queues,
  startAdvance,
  type PageJob,
  type PipelineDeps,
} from "./deps.ts";

/**
 * `POST /v1/documents/{id}/offset`: accepts the proposed segments, or replaces
 * them with the uploader's corrections, and starts the full read.
 */
export async function confirmOffset(
  deps: Pick<PipelineDeps, "db" | "boss" | "clock">,
  orgId: string,
  documentId: string,
  corrected: readonly { printed_from: number; pdf_from: number }[] | undefined,
): Promise<void> {
  await deps.db.transaction(async (tx) => {
    const { rows } = await tx.query<{
      status: string;
      offset_segments: OffsetSegment[] | null;
    }>(
      "SELECT status, offset_segments FROM documents WHERE id = $1 AND org_id = $2 FOR UPDATE",
      [documentId, orgId],
    );
    const doc = rows[0];
    if (!doc) throw new Refusal("not_found", `No document ${documentId}.`);
    if (doc.status !== "awaiting_offset") {
      throw new Refusal(
        "wrong_state",
        `The offset can only be confirmed while the document is awaiting_offset; it is ${doc.status}.`,
      );
    }
    const segments = (corrected ?? doc.offset_segments ?? []).map((s) => ({
      printed_from: s.printed_from,
      pdf_from: s.pdf_from,
      confirmed: true,
    }));
    if (segments.length === 0) {
      throw new Refusal(
        "invalid_request",
        'No page numbers were found to propose an offset. Send `segments`, for example [{ "printed_from": 1, "pdf_from": 5 }].',
      );
    }
    const problems = segmentProblems(segments);
    if (problems.length > 0) {
      throw new Refusal("invalid_request", problems.join(" "), {
        details: { problems },
      });
    }
    await tx.query(
      "UPDATE documents SET offset_segments = $2, offset_confirmed_at = $3 WHERE id = $1",
      [documentId, JSON.stringify(segments), deps.clock()],
    );
    await startReading(deps, tx, documentId, segments);
  });
}

/** The offset is confirmed: queue one read task per page (step 2). */
export async function startReading(
  deps: Pick<PipelineDeps, "boss">,
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
    await deps.boss.send(
      queues.readPage,
      { documentId, pdfPage: pdf_page } satisfies PageJob,
      { db: inTransaction(tx) },
    );
  }
  if (pending.rows.length === 0) {
    await startAdvance(deps.boss, tx, documentId);
  }
}
