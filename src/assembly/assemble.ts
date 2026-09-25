// Turns page readings into the result (spec #1 §4 steps 3–9). Pure: the same
// readings, tree and offset always give the same result, and nothing here calls
// a model (hard rule 4).
import type { DocumentType } from "../contract/document.ts";
import type { OutlineNode } from "../contract/outline.ts";
import { pdfToPrinted, type OffsetSegment } from "../offset/segments.ts";
import type { Block, PageReading } from "../reading/blocks.ts";
import type { ResultBody, StoredQuestion } from "./result.ts";
import { indexTree, type IndexedNode } from "./tree-index.ts";

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

export function assemble(input: AssemblyInput): ResultBody {
  const index = indexTree(input.tree);
  const result: ResultBody = {
    stimuli: [],
    questions: [],
    explanation: [],
    skipped: { neither: 0, off_type: 0 },
    failures: [],
  };
  const wantsQuestions = input.type !== "explanation";

  for (const failed of [...input.failedPages].sort(
    (a, b) => a.pdf_page - b.pdf_page,
  )) {
    result.failures.push({
      reason: "part_failed",
      locator: {
        pdf_page: failed.pdf_page,
        printed_page: pdfToPrinted(input.segments, failed.pdf_page),
      },
      detail: failed.detail,
    });
  }

  for (const page of [...input.pages].sort((a, b) => a.pdf_page - b.pdf_page)) {
    const printed = pdfToPrinted(input.segments, page.pdf_page);
    const locator = { pdf_page: page.pdf_page, printed_page: printed };
    const nodes = printed === null ? [] : index.deepest(printed);
    const node = nodes[0];
    const unplaced: Block[] = [];

    for (const block of page.blocks) {
      if (block.kind === "neither") {
        result.skipped.neither++;
        continue;
      }
      if (block.kind !== "question") {
        if (block.kind === "explanation" && wantsQuestions)
          result.skipped.off_type++;
        continue;
      }
      if (!wantsQuestions) {
        result.skipped.off_type++;
        continue;
      }
      if (node === undefined) {
        unplaced.push(block);
        continue;
      }
      result.questions.push(toQuestion(block, node, locator));
    }

    if (unplaced.length > 0) {
      result.failures.push({
        reason: "unmapped_page",
        locator,
        detail: `${String(unplaced.length)} block(s) on a page outside every node's range`,
      });
    }
  }
  return result;
}

function toQuestion(
  block: Block,
  node: IndexedNode,
  locator: { pdf_page: number; printed_page: number | null },
): StoredQuestion {
  const q = block.question;
  if (q === null)
    throw new Error(`block ${block.id} is a question without question fields`);
  return {
    id: `q_${block.id.replace("#", "_").slice(1)}`,
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
    locator,
    idea_tag: null,
    math_direction: block.math_direction,
    image: null,
    review_required: block.repaired !== null,
    review_reason: block.repaired === null ? null : "repaired",
    confidence: block.confidence,
  };
}
