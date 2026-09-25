// `/v1/` document shapes (spec #1 §3). `/v1/` only ever gains fields; clients
// ignore fields they don't know.
import { z } from "zod";
import { OffsetSegment } from "../offset/segments.ts";

export const DocumentType = z.enum(["questions", "explanation", "both"]);
export type DocumentType = z.infer<typeof DocumentType>;

export const DocumentStatus = z.enum([
  "queued",
  "rendering",
  "awaiting_offset",
  "processing",
  "completed",
  "completed_with_errors",
  "failed",
]);
export type DocumentStatus = z.infer<typeof DocumentStatus>;

export const TERMINAL_STATUSES: readonly DocumentStatus[] = [
  "completed",
  "completed_with_errors",
  "failed",
];

export const QuestionType = z.enum([
  "multiple_choice",
  "fill_blank",
  "true_false",
]);
export type QuestionType = z.infer<typeof QuestionType>;

export const MathDirection = z.enum(["ltr", "rtl"]);
export type MathDirection = z.infer<typeof MathDirection>;

export const Locator = z.object({
  pdf_page: z.int(),
  printed_page: z.int().nullable(),
});
export type Locator = z.infer<typeof Locator>;

export const Image = z.object({ url: z.string() });

export const ReviewReason = z
  .string()
  .describe(
    "grouping_uncertain | cut_off | model_answer | heading_not_found | latex_invalid | … (clients treat unknown reasons as a generic flag)",
  );

export const Question = z.object({
  id: z.string(),
  type: QuestionType,
  number: z.string().nullable(),
  text: z.string(),
  options: z.array(z.object({ key: z.string(), text: z.string() })),
  correct: z.array(z.string()),
  accepted_answers: z.array(z.string()),
  answer_source: z.enum(["book", "marked", "model"]).nullable(),
  node_id: z.string(),
  node_path: z.array(z.string()),
  external_ref: z.string().nullable(),
  stimulus_id: z.string().nullable(),
  locator: Locator,
  idea_tag: z.string().nullable(),
  math_direction: MathDirection.nullable(),
  image: Image.nullable(),
  review_required: z.boolean(),
  review_reason: ReviewReason.nullable(),
  confidence: z.number(),
});
export type Question = z.infer<typeof Question>;

export const Stimulus = z.object({
  id: z.string(),
  kind: z.enum(["passage", "diagram", "table"]),
  text: z.string(),
  node_id: z.string(),
  pages: z.array(z.int()),
  image: Image.nullable(),
});
export type Stimulus = z.infer<typeof Stimulus>;

export const ExplanationChunk = z.object({
  id: z.string(),
  node_id: z.string(),
  node_path: z.array(z.string()),
  external_ref: z.string().nullable(),
  heading: z.string(),
  markdown: z.string(),
  math_direction: MathDirection.nullable(),
  figures: z.array(Image),
  pages: z.object({ pdf: z.array(z.int()), printed: z.array(z.int()) }),
  review_required: z.boolean(),
  review_reason: ReviewReason.nullable(),
});
export type ExplanationChunk = z.infer<typeof ExplanationChunk>;

export const FailureReason = z
  .string()
  .describe(
    "unmapped_page | offset_break | image_unreadable | incomplete_question | part_failed (clients treat unknown reasons as a generic failure)",
  );

export const Failure = z.object({
  reason: FailureReason,
  locator: Locator,
  detail: z.string().nullable(),
  /** The page the failure is on, so it can be fixed by hand in review. */
  page_image: Image.nullable(),
});
export type Failure = z.infer<typeof Failure>;

export const Skipped = z.object({
  neither: z.int(),
  off_type: z.int(),
});

export const Document = z.object({
  id: z.string(),
  object: z.literal("document"),
  type: DocumentType,
  status: DocumentStatus,
  revision: z.int(),
  outline_id: z.string(),
  created_at: z.string(),
  expires_at: z.string(),
  progress: z.object({ pages_total: z.int().nullable(), pages_read: z.int() }),
  usage: z.object({ pages: z.int() }),
  offset: z.array(OffsetSegment),
  /** Share of the quick pass's page numbers that agree with the proposed offset (0–1). */
  offset_agreement: z.number().nullable(),
  stimuli: z.array(Stimulus),
  questions: z.array(Question),
  explanation: z.array(ExplanationChunk).optional(),
  skipped: Skipped,
  failures: z.array(Failure),
});
export type Document = z.infer<typeof Document>;

export const CreateDocumentRequest = z.object({
  outline_id: z.string(),
  type: DocumentType,
  source: z.union([
    z.object({ upload_id: z.string() }),
    z.object({ upload_ids: z.array(z.string()).min(1).max(800) }),
  ]),
  language: z.enum(["ar", "en"]).optional(),
  /** "auto" pre-approves the proposed printed → PDF mapping when agreement is high. */
  offset: z.enum(["auto", "confirm"]).optional(),
  webhook_url: z.url({ protocol: /^https?$/ }).optional(),
});
export type CreateDocumentRequest = z.infer<typeof CreateDocumentRequest>;

export const ConfirmOffsetRequest = z.object({
  /** Corrected segments. Omit to accept the proposed ones. */
  segments: z
    .array(z.object({ printed_from: z.int().min(1), pdf_from: z.int().min(1) }))
    .min(1)
    .optional(),
});
