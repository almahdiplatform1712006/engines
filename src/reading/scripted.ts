// A PageReader that returns prepared pages instead of calling a model. The
// pipeline's integration tests run on it, so CI needs no model key.
import { toPageReading, type ModelPage } from "./blocks.ts";
import type { PageReader, RecordCall } from "./reader.ts";

export interface Script {
  /** What each PDF page "says". Pages not listed read as empty. */
  pages: Record<number, ModelPage>;
  /** PDF pages whose read throws this many times before succeeding (Infinity: always). */
  failures?: Record<number, number>;
  record?: RecordCall;
}

export function scriptedReader(
  script: Script,
): PageReader & { reads: number[] } {
  const failuresLeft = new Map(
    Object.entries(script.failures ?? {}).map(([page, count]) => [
      Number(page),
      count,
    ]),
  );
  const reads: number[] = [];
  return {
    reads,
    async readPage(image, context) {
      reads.push(image.pdfPage);
      const left = failuresLeft.get(image.pdfPage) ?? 0;
      const ok = left <= 0;
      if (!ok) failuresLeft.set(image.pdfPage, left - 1);
      await script.record?.({
        context,
        purpose: "read_page",
        pdfPage: image.pdfPage,
        model: "scripted",
        finishReason: ok ? "stop" : "error",
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        ok,
        error: ok ? null : "scripted failure",
      });
      if (!ok)
        throw new Error(
          `scripted failure reading page ${String(image.pdfPage)}`,
        );
      const page = script.pages[image.pdfPage] ?? {
        printed_page: null,
        blocks: [],
      };
      return toPageReading(image.pdfPage, page);
    },
  };
}
