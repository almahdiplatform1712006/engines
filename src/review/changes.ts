// Review's fixes, applied to a result (E-18). Pure: the latest revision and
// the changes in, the next revision out. A fixed item's review flag is
// cleared: a person looked at it. Placement stays plain code (hard rule 4):
// an item moves only to the node the reviewer named.
import { toQuestion } from "../assembly/items.ts";
import type { ResultBody, StoredImage } from "../assembly/result.ts";
import type { TreeIndex } from "../assembly/tree-index.ts";
import type { Locator } from "../contract/document.ts";
import type { Change } from "../contract/revision.ts";
import type { Block } from "../reading/blocks.ts";
import { Refusal } from "../shared/refusal.ts";

export interface ReviewContext {
  tree: TreeIndex;
  /** A block the model read on a page, with where it is; null when there's none. */
  block(
    pdfPage: number,
    blockId: string,
  ): { block: Block; locator: Locator } | null;
}

interface Flagged {
  review_required: boolean;
  review_reason: string | null;
}

function fixed(item: Flagged): void {
  item.review_required = false;
  item.review_reason = null;
}

export function applyChanges(
  latest: ResultBody,
  changes: readonly Change[],
  context: ReviewContext,
): ResultBody {
  const result = structuredClone(latest);
  // Failures are named by their index in the latest revision, so several
  // dismissals in one save don't shift each other.
  const dismissed = new Set<number>();
  for (const change of changes) {
    if (change.op === "dismiss_failure") {
      if (change.index >= latest.failures.length)
        throw missing(`failure ${String(change.index)}`);
      dismissed.add(change.index);
    } else apply(result, change, context);
  }
  result.failures = result.failures.filter((_, i) => !dismissed.has(i));
  return result;
}

function apply(
  result: ResultBody,
  change: Exclude<Change, { op: "dismiss_failure" }>,
  context: ReviewContext,
): void {
  const question = (id: string) => {
    const found = result.questions.find((q) => q.id === id);
    if (!found) throw missing(id);
    return found;
  };
  const node = (id: string) => {
    const found = context.tree.byId.get(id);
    if (!found)
      throw new Refusal("invalid_request", `No node ${id} in the outline.`);
    return found;
  };

  switch (change.op) {
    case "edit_question": {
      const q = question(change.id);
      if (change.text !== undefined) q.text = change.text;
      if (change.type !== undefined) q.type = change.type;
      if (change.options !== undefined) q.options = change.options;
      if (change.correct !== undefined) q.correct = change.correct;
      if (change.accepted_answers !== undefined)
        q.accepted_answers = change.accepted_answers;
      if (q.type === "multiple_choice") {
        const keys = new Set(q.options.map((o) => o.key));
        const unknown = q.correct.filter((k) => !keys.has(k));
        if (unknown.length > 0) {
          throw new Refusal(
            "invalid_request",
            `Question ${q.id}: ${unknown.join(", ")} isn't one of its options.`,
          );
        }
      }
      // A person set the answer: it's theirs now, not the book's or the model's.
      if (change.correct !== undefined || change.accepted_answers !== undefined)
        q.answer_source = "review";
      fixed(q);
      return;
    }
    case "accept_answer": {
      const q = question(change.id);
      if (q.correct.length === 0 && q.accepted_answers.length === 0) {
        throw new Refusal(
          "invalid_request",
          `Question ${change.id} has no answer to accept.`,
        );
      }
      fixed(q);
      return;
    }
    case "set_stimulus": {
      const q = question(change.id);
      if (
        change.stimulus_id !== null &&
        !result.stimuli.some((s) => s.id === change.stimulus_id)
      )
        throw missing(change.stimulus_id);
      q.stimulus_id = change.stimulus_id;
      fixed(q);
      return;
    }
    case "move": {
      const to = node(change.node_id);
      const item =
        result.questions.find((q) => q.id === change.id) ??
        result.explanation.find((c) => c.id === change.id);
      if (!item) throw missing(change.id);
      item.node_id = to.node.id;
      item.node_path = to.path;
      item.external_ref = to.node.external_ref;
      fixed(item);
      return;
    }
    case "delete": {
      const before =
        result.questions.length +
        result.explanation.length +
        result.stimuli.length;
      result.questions = result.questions.filter((q) => q.id !== change.id);
      result.explanation = result.explanation.filter((c) => c.id !== change.id);
      result.stimuli = result.stimuli.filter((s) => s.id !== change.id);
      for (const q of result.questions) {
        if (q.stimulus_id === change.id) q.stimulus_id = null;
      }
      const after =
        result.questions.length +
        result.explanation.length +
        result.stimuli.length;
      if (after === before) throw missing(change.id);
      return;
    }
    case "edit_chunk": {
      const chunk = result.explanation.find((c) => c.id === change.id);
      if (!chunk) throw missing(change.id);
      if (change.heading !== undefined) chunk.heading = change.heading;
      if (change.markdown !== undefined) chunk.markdown = change.markdown;
      fixed(chunk);
      return;
    }
    case "recrop": {
      // A new box, no key: the crop is cut again for this revision.
      const recut = (
        image: StoredImage | null,
        pdfPage: number,
      ): StoredImage => ({
        pdf_page: image?.pdf_page ?? pdfPage,
        box: change.box,
        key: null,
      });
      const q = result.questions.find((x) => x.id === change.id);
      if (q) {
        q.image = recut(q.image, q.locator.pdf_page);
        fixed(q);
        return;
      }
      const stimulus = result.stimuli.find((s) => s.id === change.id);
      if (stimulus) {
        stimulus.image = recut(stimulus.image, stimulus.pages[0] ?? 1);
        return;
      }
      const chunk = result.explanation.find((c) => c.id === change.id);
      if (chunk) {
        const at = change.figure ?? chunk.figures.length;
        if (at > chunk.figures.length)
          throw missing(`${change.id} figure ${String(at)}`);
        chunk.figures[at] = recut(
          chunk.figures[at] ?? null,
          chunk.pages.pdf[0] ?? 1,
        );
        fixed(chunk);
        return;
      }
      throw missing(change.id);
    }
    case "place_block": {
      const found = context.block(change.pdf_page, change.block_id);
      if (found?.block.kind !== "question" || !found.block.question) {
        throw new Refusal(
          "invalid_request",
          `No question block ${change.block_id} on page ${String(change.pdf_page)}.`,
        );
      }
      const placed = toQuestion(
        {
          block: found.block,
          node: node(change.node_id),
          locator: found.locator,
          idea_tag: null,
          flag: null,
        },
        null,
        null,
        [],
      );
      if (result.questions.some((q) => q.id === placed.id)) {
        throw new Refusal(
          "invalid_request",
          `Question ${placed.id} is already in the result.`,
        );
      }
      // Placed by a person: the answer still needs setting, so it stays flagged.
      placed.review_required = true;
      placed.review_reason = "placed_in_review";
      result.questions.push(placed);
      return;
    }
  }
}

function missing(id: string): Refusal {
  return new Refusal("invalid_request", `No ${id} in the latest revision.`);
}
