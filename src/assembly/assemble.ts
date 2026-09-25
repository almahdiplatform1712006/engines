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
import { applyJoins, type Join } from "./continuations.ts";
import { place, type Placed } from "./placement.ts";
import type {
  ResultBody,
  StoredImage,
  StoredQuestion,
  StoredStimulus,
} from "./result.ts";
import { linkStimuli } from "./stimuli.ts";
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
  /** Blocks re-read across a page break (step 4), replacing their halves. */
  joins?: readonly Join[];
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

  // Step 4: joined blocks replace their halves.
  const pages = applyJoins(input.pages, input.joins ?? []).sort(
    (a, b) => a.pdf_page - b.pdf_page,
  );
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
  const questionItems: { item: Placed; order: number }[] = [];
  const drafts: DraftStimulus[] = [];
  const stimulusOrder = new Map<string, number>();
  placed.forEach((item, order) => {
    const kind = item.block.kind;
    if (kind === "heading") return;
    if (!delivers.includes(kind)) {
      result.skipped.off_type++;
      return;
    }
    if (kind === "question") questionItems.push({ item, order });
    if (kind === "passage") {
      const stimulus = toStimulus(item);
      drafts.push(stimulus);
      stimulusOrder.set(stimulus.id, order);
    }
  });

  // Step 6: link questions to their passage or figure.
  const links = linkStimuli(
    questionItems.map(({ item, order }) => ({
      id: itemId("q", item.block.id),
      node_id: item.node.node.id,
      pdf_page: item.block.pdf_page,
      order,
      number: item.block.question?.number ?? null,
      stimulus_label: item.block.question?.stimulus_label ?? null,
    })),
    drafts.map((s) => ({
      id: s.id,
      node_id: s.node_id,
      pdf_page: s.pages[0] ?? 0,
      order: stimulusOrder.get(s.id) ?? 0,
      label: s.label,
      covers: s.covers,
    })),
  );
  const stimuli = new Map(drafts.map((s) => [s.id, s]));
  result.stimuli = drafts.map(toStoredStimulus);

  for (const { item } of questionItems) {
    const link = links.get(itemId("q", item.block.id));
    const flags: string[] = link?.uncertain ? ["grouping_uncertain"] : [];

    // A question that needs a figure gets it from its linked stimulus, or its
    // own box; with neither, the owner crops it by hand in review.
    let image: StoredImage | null = null;
    const linked = link ? stimuli.get(link.stimulus_id) : undefined;
    if (item.block.question?.needs_figure && !linked?.image) {
      if (item.block.box) {
        image = {
          pdf_page: item.block.pdf_page,
          box: item.block.box,
          key: null,
        };
      } else {
        flags.push("image_unreadable");
        result.failures.push({
          reason: "image_unreadable",
          locator: item.locator,
          detail: `question ${item.block.question.number ?? itemId("q", item.block.id)} needs a figure that could not be located; crop it from the page in review`,
        });
      }
    }

    const question = toQuestion(item, link?.stimulus_id ?? null, image, flags);
    // A question cut off at a page break, with no join, that is too broken to
    // answer is not delivered as an item: it's an incomplete_question failure.
    if (question.review_reason === "cut_off" && !answerable(question)) {
      result.failures.push({
        reason: "incomplete_question",
        locator: item.locator,
        detail: `question ${question.number ?? "(no number)"} is cut off at a page break: «${question.text.slice(0, 80)}»`,
      });
    } else {
      result.questions.push(question);
    }
  }

  result.failures.sort((a, b) => a.locator.pdf_page - b.locator.pdf_page);
  return result;
}

/** A stable item id from the block it came from: `q_93_2` for block 2 of PDF page 93. */
export function itemId(prefix: string, blockId: string): string {
  return `${prefix}_${blockId.slice(1).replace("#", "_")}`;
}

function toQuestion(
  item: Placed,
  stimulusId: string | null,
  image: StoredImage | null,
  extraFlags: readonly string[],
): StoredQuestion {
  const { block, node } = item;
  const q = block.question;
  if (q === null)
    throw new Error(`block ${block.id} is a question without question fields`);
  const flags = [
    // A block still flagged as running across a page break was never joined.
    block.continues || block.continued_from ? "cut_off" : null,
    item.flag,
    ...extraFlags,
    block.repaired === null ? null : "repaired",
  ].filter((f) => f !== null);
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
    stimulus_id: stimulusId,
    locator: item.locator,
    idea_tag: item.idea_tag,
    math_direction: block.math_direction,
    image,
    review_required: flags.length > 0,
    review_reason: flags[0] ?? null,
    confidence: block.confidence,
  };
}

/** A stimulus, with what linking needs kept aside (`label`, `covers`) until the result is written. */
type DraftStimulus = StoredStimulus & {
  label: string | null;
  covers: { from: string; to: string } | null;
};

function toStoredStimulus(draft: DraftStimulus): StoredStimulus {
  return {
    id: draft.id,
    kind: draft.kind,
    text: draft.text,
    node_id: draft.node_id,
    pages: draft.pages,
    image: draft.image,
  };
}

function toStimulus(item: Placed): DraftStimulus {
  const { block, node } = item;
  const kind = block.stimulus?.kind ?? "passage";
  return {
    id: itemId("s", block.id),
    kind,
    text: block.text,
    node_id: node.node.id,
    pages:
      block.continues_on === undefined
        ? [block.pdf_page]
        : [block.pdf_page, block.continues_on],
    // Diagrams and tables are delivered as a crop of the page too.
    image:
      kind !== "passage" && block.box
        ? { pdf_page: block.pdf_page, box: block.box, key: null }
        : null,
    label: block.stimulus?.label ?? null,
    covers: block.stimulus?.covers ?? null,
  };
}

/** Enough of a question survives to answer it: a stem, and options where its type needs them. */
function answerable(question: StoredQuestion): boolean {
  if (question.text.trim() === "") return false;
  if (question.type === "multiple_choice") return question.options.length >= 2;
  return true;
}
