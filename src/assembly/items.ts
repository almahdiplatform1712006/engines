// Delivered items built from placed blocks: questions and stimuli, with ids
// that stay the same across revisions.
import type { Block } from "../reading/blocks.ts";
import type { Placed } from "./placement.ts";
import type { StoredImage, StoredQuestion, StoredStimulus } from "./result.ts";

/** A stable item id from the block it came from: `q_93_2` for block 2 of PDF page 93. */
export function itemId(prefix: string, blockId: string): string {
  return `${prefix}_${blockId.slice(1).replace("#", "_")}`;
}

/** A diagram or table the reader could box: delivered as a crop of the page. */
export function isFigure(
  block: Block,
): block is Block & { box: NonNullable<Block["box"]> } {
  return (
    block.kind === "passage" &&
    block.stimulus !== null &&
    block.stimulus.kind !== "passage" &&
    block.box !== null
  );
}

export function toQuestion(
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

/** Enough of a question survives to answer it: a stem, and options where its type needs them. */
export function answerable(question: StoredQuestion): boolean {
  if (question.text.trim() === "") return false;
  if (question.type === "multiple_choice") return question.options.length >= 2;
  return true;
}

/** A stimulus, with what linking needs kept aside until the result is written. */
export interface DraftStimulus extends StoredStimulus {
  block_id: string;
  order: number;
  label: string | null;
  covers: { from: string; to: string } | null;
}

export function toStimulus(item: Placed, order: number): DraftStimulus {
  const { block, node } = item;
  return {
    id: itemId("s", block.id),
    kind: block.stimulus?.kind ?? "passage",
    text: block.text,
    node_id: node.node.id,
    pages:
      block.continues_on === undefined
        ? [block.pdf_page]
        : [block.pdf_page, block.continues_on],
    image: isFigure(block)
      ? { pdf_page: block.pdf_page, box: block.box, key: null }
      : null,
    block_id: block.id,
    order,
    label: block.stimulus?.label ?? null,
    covers: block.stimulus?.covers ?? null,
  };
}

export function toStoredStimulus(draft: DraftStimulus): StoredStimulus {
  return {
    id: draft.id,
    kind: draft.kind,
    text: draft.text,
    node_id: draft.node_id,
    pages: draft.pages,
    image: draft.image,
  };
}
