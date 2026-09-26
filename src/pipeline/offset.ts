// The offset confirmation (E-07): the uploader accepts or corrects the proposed
// segments, and the full read starts.
import { segmentProblems, type OffsetSegment } from "../offset/segments.ts";
import { Refusal } from "../shared/refusal.ts";
import { admit } from "./admit.ts";
import type { PipelineDeps } from "./deps.ts";

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
      api_key_id: string;
      offset_segments: OffsetSegment[] | null;
      offset_confirmed_at: Date | null;
    }>(
      `SELECT status, api_key_id, offset_segments, offset_confirmed_at
       FROM documents WHERE id = $1 AND org_id = $2 FOR UPDATE`,
      [documentId, orgId],
    );
    const doc = rows[0];
    if (!doc) throw new Refusal("not_found", `No document ${documentId}.`);
    if (doc.status !== "awaiting_offset" || doc.offset_confirmed_at !== null) {
      throw new Refusal(
        "wrong_state",
        doc.status === "awaiting_offset"
          ? "The offset is already confirmed; the full read starts as soon as a slot is free."
          : `The offset can only be confirmed while the document is awaiting_offset; it is ${doc.status}.`,
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
    // The full read starts as soon as the key has a free slot.
    await admit(deps.boss, tx, doc.api_key_id);
  });
}
