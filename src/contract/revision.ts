// `POST /v1/documents/{id}/revisions` (E-18, spec §1 step 7): fixes made in
// review, each a change to the latest revision. The original is never
// overwritten: the changes and the result they make are a new revision.
import { z } from "zod";
import { CropBox } from "./crop.ts";
import { QuestionType } from "./document.ts";

const ItemId = z.string().min(1);
/** The smallest crop, as a fraction of the page's width or height. */
export const MIN_CROP = 0.01;
const Option = z.object({ key: z.string().min(1), text: z.string() });

export const Change = z.discriminatedUnion("op", [
  /** Fix a question's text, type, options or answer. */
  z.object({
    op: z.literal("edit_question"),
    id: ItemId,
    text: z.string().trim().min(1).optional(),
    type: QuestionType.optional(),
    options: z.array(Option).optional(),
    correct: z.array(z.string()).optional(),
    accepted_answers: z.array(z.string()).optional(),
  }),
  /** Keep the model's answer (`model_answer`) as it is. */
  z.object({ op: z.literal("accept_answer"), id: ItemId }),
  /** Link a question to a shared passage, or unlink it (`grouping_uncertain`). */
  z.object({
    op: z.literal("set_stimulus"),
    id: ItemId,
    stimulus_id: ItemId.nullable(),
  }),
  /** File a question or explanation chunk under another node. */
  z.object({ op: z.literal("move"), id: ItemId, node_id: z.string().min(1) }),
  /** Remove junk: a question, chunk or passage (its questions are unlinked). */
  z.object({ op: z.literal("delete"), id: ItemId }),
  /** Fix an explanation chunk's heading or text. */
  z.object({
    op: z.literal("edit_chunk"),
    id: ItemId,
    heading: z.string().optional(),
    markdown: z.string().optional(),
  }),
  /**
   * A new crop box on the page image (`image_unreadable`, `cut_off`); the crop
   * is cut again from the stored page. `figure` picks a chunk's figure.
   */
  z.object({
    op: z.literal("recrop"),
    id: ItemId,
    figure: z.int().min(0).optional(),
    box: CropBox.refine((b) => b.w >= MIN_CROP && b.h >= MIN_CROP, {
      error: `a crop box is at least ${String(MIN_CROP)} of the page each way`,
    }),
  }),
  /** Place a question the model read on a page that wasn't placed (`failures`). */
  z.object({
    op: z.literal("place_block"),
    pdf_page: z.int().min(1),
    block_id: z.string().min(1),
    node_id: z.string().min(1),
  }),
  /** Mark a failure as dealt with, by its index in `failures`. */
  z.object({ op: z.literal("dismiss_failure"), index: z.int().min(0) }),
]);
export type Change = z.infer<typeof Change>;

export const CreateRevisionRequest = z.object({
  /**
   * The revision these changes were made on. Refused (409) when the document
   * has moved on since, so a stale tab or a retry never overwrites newer fixes.
   */
  base_revision: z.int().min(1),
  changes: z.array(Change).min(1).max(500),
});
export type CreateRevisionRequest = z.infer<typeof CreateRevisionRequest>;
