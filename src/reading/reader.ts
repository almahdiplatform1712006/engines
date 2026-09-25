// The seam between Engines and the model (ADR 0001). Everything the pipeline
// asks a model goes through a PageReader. Two adapters: `createModelReader`
// (Vercel AI SDK) and `scriptedReader` (tests and local runs without a key).
import type { PageReading } from "./blocks.ts";

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
  /** Step 2: every block on one page, one image per call. */
  readPage(image: PageImage, context: CallContext): Promise<PageReading>;
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
