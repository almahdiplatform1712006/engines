import assert from "node:assert/strict";
import { test } from "node:test";
import { questionChecks } from "./checks.ts";
import type { StoredQuestion } from "./result.ts";

const base: StoredQuestion = {
  id: "q_1_0",
  type: "multiple_choice",
  number: "1",
  text: "ما قيمة $g$؟",
  options: [
    { key: "أ", text: "$9.8\\ \\text{m/s}^2$" },
    { key: "ب", text: "$10$" },
  ],
  correct: ["أ"],
  accepted_answers: [],
  answer_source: "book",
  node_id: "l1",
  node_path: ["l1"],
  external_ref: null,
  stimulus_id: null,
  locator: { pdf_page: 1, printed_page: 1 },
  idea_tag: null,
  math_direction: "ltr",
  image: null,
  review_required: false,
  review_reason: null,
  confidence: 0.9,
};

test("a sound question passes every check", () => {
  assert.deepEqual(questionChecks(base), []);
});

test("2–6 options for multiple choice", () => {
  assert.deepEqual(
    questionChecks({ ...base, options: base.options.slice(0, 1), correct: [] }),
    ["options_count"],
  );
});

test("the correct answer must be one of the options", () => {
  assert.deepEqual(questionChecks({ ...base, correct: ["هـ"] }), [
    "answer_not_in_options",
  ]);
});

test("an answered blank needs accepted answers", () => {
  assert.deepEqual(
    questionChecks({ ...base, type: "fill_blank", options: [], correct: [] }),
    ["no_accepted_answers"],
  );
});

test("LaTeX must parse in KaTeX", () => {
  assert.deepEqual(questionChecks({ ...base, text: "احسب $\\frac{1}{$" }), [
    "latex_invalid",
  ]);
});
