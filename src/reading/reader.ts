// The seam between Engines and the model (ADR 0001). Everything the pipeline
// asks a model goes through a PageReader. Two adapters: `createModelReader`
// (Vercel AI SDK) and `scriptedReader` (tests and local runs without a key).
import type { CropBox } from "../contract/crop.ts";
import type { ContentsEntry } from "../outline/draft.ts";
import type { Block, PageReading } from "./blocks.ts";

export interface PageImage {
  pdfPage: number;
  bytes: Uint8Array;
  mediaType: "image/png";
}

/** Who a call is for, so its usage and cost are logged against the right job. */
export interface CallContext {
  orgId: string;
  documentId: string | null;
}

export interface PageReader {
  /** Step 1b: only the printed page number, with the cheap model. Raw, as printed. */
  readPrintedNumber(
    image: PageImage,
    context: CallContext,
  ): Promise<string | null>;
  /** Step 2: every block on one page, one image per call. */
  readPage(image: PageImage, context: CallContext): Promise<PageReading>;
  /**
   * Step 4: both pages of a flagged pair in one call. Returns the block that
   * runs across the break, whole, as a block of the first page.
   */
  readPair(
    pages: readonly [PageImage, PageImage],
    halves: readonly [Block, Block],
    context: CallContext,
  ): Promise<Block>;
  /**
   * Step 7: answers a question that has no book or marked answer (always
   * flagged). `figure` is the crop of its diagram, when it has one.
   */
  solve(
    question: SolveRequest,
    context: CallContext,
    figure?: PageImage,
  ): Promise<SolvedAnswer>;
  /**
   * Syllabus drafting (E-16): the entries of one contents page, in reading
   * order. `image.pdfPage` is the page's place in the syllabus.
   */
  readContents(
    image: PageImage,
    context: CallContext,
  ): Promise<ContentsEntry[]>;
}

/** A question for the model to solve, with its shared passage when it has one. */
export interface SolveRequest {
  question_id: string;
  number: string | null;
  type: "multiple_choice" | "fill_blank" | "true_false";
  text: string;
  options: { key: string; text: string }[];
  /** The text of the question's passage, when it has one. */
  stimulus: string | null;
  /** Where the question's figure is on its page, when it has one; sent as an image. */
  figure: { pdf_page: number; box: CropBox } | null;
}

export interface SolvedAnswer {
  correct: string[];
  accepted_answers: string[];
}

/** One model call, as the model-call log records it. */
export interface ModelCall {
  context: CallContext;
  purpose:
    "read_page" | "read_number" | "read_pair" | "solve" | "read_contents";
  pdfPage: number | null;
  model: string;
  finishReason: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  ok: boolean;
  error: string | null;
}

export type RecordCall = (call: ModelCall) => Promise<void>;
