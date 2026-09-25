// A PageReader that returns prepared answers instead of calling a model. The
// pipeline's integration tests run on it, so CI needs no model key.
import {
  toBlock,
  toPageReading,
  type ModelBlock,
  type ModelPage,
} from "./blocks.ts";
import type { ContentsEntry } from "../outline/draft.ts";
import type { PageReader, RecordCall, SolvedAnswer } from "./reader.ts";

export interface Script {
  /** What each PDF page "says". Pages not listed read as empty. */
  pages: Record<number, ModelPage>;
  /** PDF pages whose read throws this many times before succeeding (Infinity: always). */
  failures?: Record<number, number>;
  /**
   * What the quick pass reads as each page's number. Defaults to the page's
   * `printed_page`; set a page here to make the cheap read disagree.
   */
  numbers?: Record<number, string | null>;
  /** The joined block a pair re-read returns, by the pair's first PDF page. Unlisted pairs fail. */
  joins?: Record<number, ModelBlock>;
  /**
   * What the model answers, by question number; unlisted questions fail to
   * solve. Without this, every question is answered with its first option (or
   * "answer" for a blank).
   */
  solutions?: Record<string, SolvedAnswer>;
  /** What each syllabus page's contents read as, by its place in the syllabus. Unlisted pages read as empty. */
  contents?: Record<number, ContentsEntry[]>;
  /** Syllabus pages whose contents read throws (every time). */
  contentsFailures?: number[];
  record?: RecordCall;
}

export interface ScriptedReader extends PageReader {
  /** PDF pages read in full, in call order (a retried page appears twice). */
  reads: number[];
  /** PDF pages whose printed number the quick pass read. */
  numberReads: number[];
  /** First PDF pages of the pairs re-read. */
  pairReads: number[];
  /** Ids of the questions the model was asked to solve. */
  solves: string[];
  /** Syllabus pages whose contents were read. */
  contentsReads: number[];
}

export function scriptedReader(script: Script): ScriptedReader {
  const failuresLeft = new Map(
    Object.entries(script.failures ?? {}).map(([page, count]) => [
      Number(page),
      count,
    ]),
  );
  const reader: ScriptedReader = {
    reads: [],
    numberReads: [],
    pairReads: [],
    solves: [],
    contentsReads: [],
    readContents(image) {
      reader.contentsReads.push(image.pdfPage);
      if (script.contentsFailures?.includes(image.pdfPage)) {
        return Promise.reject(
          new Error(`scripted: contents page ${String(image.pdfPage)} fails`),
        );
      }
      return Promise.resolve(script.contents?.[image.pdfPage] ?? []);
    },
    readPrintedNumber(image) {
      reader.numberReads.push(image.pdfPage);
      const number = script.numbers?.[image.pdfPage];
      return Promise.resolve(
        number === undefined
          ? (script.pages[image.pdfPage]?.printed_page ?? null)
          : number,
      );
    },
    async readPage(image, context) {
      reader.reads.push(image.pdfPage);
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
    readPair(_images, [first]) {
      reader.pairReads.push(first.pdf_page);
      const joined = script.joins?.[first.pdf_page];
      if (!joined) {
        return Promise.reject(
          new Error(`no scripted join for page ${String(first.pdf_page)}`),
        );
      }
      return Promise.resolve(toBlock(first.pdf_page, first.order, joined));
    },
    solve(question) {
      reader.solves.push(question.question_id);
      if (script.solutions === undefined) {
        const first = question.options[0];
        return Promise.resolve(
          first
            ? { correct: [first.key], accepted_answers: [] }
            : { correct: [], accepted_answers: ["answer"] },
        );
      }
      const solution =
        question.number === null
          ? undefined
          : script.solutions[question.number];
      if (!solution) {
        return Promise.reject(
          new Error(`no scripted solution for ${question.question_id}`),
        );
      }
      return Promise.resolve(solution);
    },
  };
  return reader;
}
