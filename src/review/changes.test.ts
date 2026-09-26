import assert from "node:assert/strict";
import { test } from "node:test";
import { mcq } from "../../test/model.ts";
import { chunk, question, result, stimulus } from "../../test/result.ts";
import { n } from "../../test/tree.ts";
import { indexTree } from "../assembly/tree-index.ts";
import { toBlock } from "../reading/blocks.ts";
import { applyChanges, type ReviewContext } from "./changes.ts";

const tree = indexTree([
  n("unit", 1, 20, [n("l1", 1, 10), n("l2", 11, 20)], {
    external_ref: "almahdi:unit",
  }),
]);
const unplaced = toBlock(30, 0, mcq("9", "سؤال خارج الشجرة"));
const context: ReviewContext = {
  tree,
  block: (pdfPage, blockId) =>
    pdfPage === 30 && blockId === unplaced.id
      ? { block: unplaced, locator: { pdf_page: 30, printed_page: 28 } }
      : null,
};

const latest = result({
  stimuli: [stimulus("s1", "l1")],
  questions: [
    question("q1", "l1", {
      review_required: true,
      review_reason: "model_answer",
      answer_source: "model",
    }),
    question("q2", "l1", {
      stimulus_id: "s1",
      review_required: true,
      review_reason: "grouping_uncertain",
    }),
    question("q3", "l1"),
  ],
  explanation: [chunk("c1", "l1")],
  failures: [
    {
      reason: "unmapped_page",
      locator: { pdf_page: 30, printed_page: 28 },
      detail: null,
    },
    {
      reason: "offset_break",
      locator: { pdf_page: 31, printed_page: null },
      detail: null,
    },
  ],
});

test("each fix changes only its item, clears its flag, and leaves the latest revision alone", () => {
  const next = applyChanges(
    latest,
    [
      { op: "accept_answer", id: "q1" },
      { op: "set_stimulus", id: "q2", stimulus_id: null },
      { op: "edit_question", id: "q3", text: "نص مصحح", correct: ["ب"] },
      { op: "move", id: "c1", node_id: "unit" },
      { op: "edit_chunk", id: "c1", heading: "عنوان" },
    ],
    context,
  );
  const [q1, q2, q3] = next.questions;
  assert.equal(q1?.review_required, false);
  assert.equal(q1.answer_source, "model", "accepted, still the model's answer");
  assert.equal(q2?.stimulus_id, null);
  assert.equal(q2.review_reason, null);
  assert.equal(q3?.text, "نص مصحح");
  assert.deepEqual(q3.correct, ["ب"]);
  const [c1] = next.explanation;
  assert.equal(c1?.node_id, "unit");
  assert.deepEqual(c1.node_path, ["unit"]);
  assert.equal(c1.external_ref, "almahdi:unit");
  assert.equal(c1.heading, "عنوان");

  assert.equal(latest.questions[0]?.review_required, true, "not mutated");
  assert.equal(latest.explanation[0]?.node_id, "l1");
});

test("delete removes junk; deleting a passage unlinks its questions", () => {
  const next = applyChanges(
    latest,
    [
      { op: "delete", id: "q3" },
      { op: "delete", id: "s1" },
    ],
    context,
  );
  assert.deepEqual(
    next.questions.map((q) => q.id),
    ["q1", "q2"],
  );
  assert.deepEqual(next.stimuli, []);
  assert.equal(next.questions[1]?.stimulus_id, null);
});

test("recrop gives the item a new box and no crop yet (cut for the new revision)", () => {
  const withImage = result({
    questions: [
      question("q1", "l1", {
        image: { pdf_page: 4, box: { x: 0, y: 0, w: 0.2, h: 0.2 }, key: "old" },
        review_required: true,
        review_reason: "image_unreadable",
      }),
    ],
    explanation: [chunk("c1", "l1")],
  });
  const box = { x: 0.1, y: 0.2, w: 0.5, h: 0.3 };
  const next = applyChanges(
    withImage,
    [
      { op: "recrop", id: "q1", box },
      { op: "recrop", id: "c1", box },
    ],
    context,
  );
  assert.deepEqual(next.questions[0]?.image, { pdf_page: 4, box, key: null });
  assert.equal(next.questions[0].review_required, false);
  assert.deepEqual(next.explanation[0]?.figures, [
    { pdf_page: 1, box, key: null },
  ]);
  assert.equal(withImage.questions[0]?.image?.key, "old");
});

test("an unplaced question is placed where the reviewer says, still flagged for its answer", () => {
  const next = applyChanges(
    latest,
    [
      {
        op: "place_block",
        pdf_page: 30,
        block_id: unplaced.id,
        node_id: "l2",
      },
      { op: "dismiss_failure", index: 0 },
    ],
    context,
  );
  const placed = next.questions.at(-1);
  assert.equal(placed?.text, "سؤال خارج الشجرة");
  assert.equal(placed.node_id, "l2");
  assert.deepEqual(placed.node_path, ["unit", "l2"]);
  assert.deepEqual(placed.locator, { pdf_page: 30, printed_page: 28 });
  assert.equal(placed.review_reason, "placed_in_review");
  assert.deepEqual(
    next.failures.map((f) => f.reason),
    ["offset_break"],
  );
});

test("dismissals name failures as they were, so two in one save don't shift", () => {
  const next = applyChanges(
    latest,
    [
      { op: "dismiss_failure", index: 1 },
      { op: "dismiss_failure", index: 0 },
    ],
    context,
  );
  assert.deepEqual(next.failures, []);
});

test("a change naming nothing real is refused, and nothing is saved", () => {
  for (const change of [
    { op: "accept_answer", id: "nope" },
    { op: "move", id: "q1", node_id: "no-node" },
    { op: "set_stimulus", id: "q1", stimulus_id: "no-stimulus" },
    { op: "place_block", pdf_page: 30, block_id: "p30#9", node_id: "l1" },
    { op: "dismiss_failure", index: 5 },
  ] as const) {
    assert.throws(() => applyChanges(latest, [change], context), {
      name: "Refusal",
    });
  }
  const answerless = result({
    questions: [question("q1", "l1", { correct: [], accepted_answers: [] })],
  });
  assert.throws(() =>
    applyChanges(answerless, [{ op: "accept_answer", id: "q1" }], context),
  );
});
