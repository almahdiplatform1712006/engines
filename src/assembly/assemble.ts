// Turns page readings into the result (spec #1 §4 steps 3–9). Pure: the same
// readings, tree and offset always give the same result, and nothing here calls
// a model (hard rule 4).
//
// Every block ends up placed, counted in `skipped`, or covered by a failure
// (hard rule 5). Headings are structure: they split shared pages, name idea
// tags and head explanation chunks.
import type { DocumentType } from "../contract/document.ts";
import type { OutlineNode } from "../contract/outline.ts";
import { checkPages } from "../offset/fit.ts";
import { pdfToPrinted, type OffsetSegment } from "../offset/segments.ts";
import type { BlockKind, PageReading } from "../reading/blocks.ts";
import { place, type Placed } from "./placement.ts";
import type { ResultBody, StoredQuestion, StoredStimulus } from "./result.ts";
import { indexTree } from "./tree-index.ts";

export interface FailedPage {
  pdf_page: number;
  detail: string;
}

export interface AssemblyInput {
  type: DocumentType;
  tree: readonly OutlineNode[];
  segments: readonly OffsetSegment[];
  /** Every page that was read, in any order. */
  pages: readonly PageReading[];
  /** Pages whose read failed after every retry. */
  failedPages: readonly FailedPage[];
}

/** Which block kinds each document type delivers. The rest are `off_type`. */
const DELIVERS: Record<DocumentType, readonly BlockKind[]> = {
  questions: ["question", "passage", "answer_key"],
  explanation: ["explanation"],
  both: ["question", "passage", "answer_key", "explanation"],
};

export function assemble(input: AssemblyInput): ResultBody {
  const index = indexTree(input.tree);
  const result: ResultBody = {
    stimuli: [],
    questions: [],
    explanation: [],
    skipped: { neither: 0, off_type: 0 },
    failures: [],
  };
  const locatorOf = (pdfPage: number) => ({
    pdf_page: pdfPage,
    printed_page: pdfToPrinted(input.segments, pdfPage),
  });

  for (const failed of input.failedPages) {
    result.failures.push({
      reason: "part_failed",
      locator: locatorOf(failed.pdf_page),
      detail: failed.detail,
    });
  }

  const pages = [...input.pages].sort((a, b) => a.pdf_page - b.pdf_page);
  for (const page of pages) {
    result.skipped.neither += page.blocks.filter(
      (b) => b.kind === "neither",
    ).length;
  }

  // Step 3: a page whose printed number contradicts the confirmed offset is
  // held, not placed. A page with nothing to deliver loses nothing, so it is no break.
  const breaks = new Map(
    checkPages(input.segments, pages).map((b) => [b.pdf_page, b]),
  );
  const held = new Set<number>();
  for (const page of pages) {
    const offsetBreak = breaks.get(page.pdf_page);
    if (!offsetBreak || !page.blocks.some((b) => b.kind !== "neither"))
      continue;
    held.add(page.pdf_page);
    result.failures.push({
      reason: "offset_break",
      locator: locatorOf(page.pdf_page),
      detail:
        offsetBreak.read === null
          ? `no printed number read; expected ${String(offsetBreak.expected)}`
          : `printed ${String(offsetBreak.read)} read; the offset expects ${String(offsetBreak.expected)}`,
    });
  }

  // Step 5: placement.
  const { placed, unmapped } = place(
    index,
    input.segments,
    pages.filter((p) => !held.has(p.pdf_page)),
  );
  for (const [pdfPage, count] of unmapped) {
    result.failures.push({
      reason: "unmapped_page",
      locator: locatorOf(pdfPage),
      detail: `${String(count)} block(s) on a page outside every node's range`,
    });
  }

  const delivers = DELIVERS[input.type];
  for (const item of placed) {
    const kind = item.block.kind;
    if (kind === "heading") continue;
    if (!delivers.includes(kind)) {
      result.skipped.off_type++;
      continue;
    }
    if (kind === "question") result.questions.push(toQuestion(item));
    if (kind === "passage") result.stimuli.push(toStimulus(item));
  }

  result.failures.sort((a, b) => a.locator.pdf_page - b.locator.pdf_page);
  return result;
}

/** A stable item id from the block it came from: `q_93_2` for block 2 of PDF page 93. */
export function itemId(prefix: string, blockId: string): string {
  return `${prefix}_${blockId.slice(1).replace("#", "_")}`;
}

function toQuestion(item: Placed): StoredQuestion {
  const { block, node } = item;
  const q = block.question;
  if (q === null)
    throw new Error(`block ${block.id} is a question without question fields`);
  const flags = [item.flag, block.repaired === null ? null : "repaired"].filter(
    (f) => f !== null,
  );
  return {
    id: itemId("q", block.id),
    type: q.type,
    number: q.number,
    text: block.text,
    options: q.options,
    correct: [],
    accepted_answers: [],
    answer_source: null,
    node_id: node.node.id,
    node_path: node.path,
    external_ref: node.node.external_ref,
    stimulus_id: null,
    locator: item.locator,
    idea_tag: item.idea_tag,
    math_direction: block.math_direction,
    image: null,
    review_required: flags.length > 0,
    review_reason: flags[0] ?? null,
    confidence: block.confidence,
  };
}

function toStimulus(item: Placed): StoredStimulus {
  const { block, node } = item;
  return {
    id: itemId("s", block.id),
    kind: block.stimulus?.kind ?? "passage",
    text: block.text,
    node_id: node.node.id,
    pages: [block.pdf_page],
    image: null,
  };
}
