// E-11: the book's answer key first, then a hand mark, then the model, always
// flagged, and only for questions that have neither.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { startHarness, type Harness } from "../../test/harness.ts";
import { mcq, modelBlock, page } from "../../test/model.ts";
import { makePdf } from "../../test/pdf.ts";
import { scriptedReader } from "../reading/scripted.ts";

const heading = (text: string) => modelBlock({ kind: "heading", text });
const key = (answers: { number: string; answer: string }[]) =>
  modelBlock({
    kind: "answer_key",
    answers: answers.map((a) => ({ section: null, ...a })),
  });

const reader = scriptedReader({
  pages: {
    1: page("1", [
      heading("الدرس الأول"),
      mcq("١", "سؤال له إجابة في الكتاب"),
      { ...mcq("2", "سؤال عليه علامة"), marked: ["ج"] },
      mcq("3", "سؤال يحله النموذج"),
    ]),
    2: page("2", [
      heading("الدرس الثاني"),
      mcq("1", "سؤال رقمه يتكرر"),
      modelBlock({
        kind: "question",
        text: "أكمل: وحدة القوة هي ....",
        question_number: "2",
        question_type: "fill_blank",
      }),
    ]),
    3: page("3", [
      heading("إجابات الدرس الأول"),
      key([{ number: "1", answer: "ب" }]),
      heading("إجابات الدرس الثاني"),
      key([{ number: "(1)", answer: "a" }]),
    ]),
  },
  // Only question 3 of lesson 1 gets an answer from the model; lesson 2's
  // question 2 has no scripted solution, so solving it fails.
  solutions: { "3": { correct: ["د"], accepted_answers: [] } },
});

let h: Harness;
before(async () => {
  h = await startHarness({
    reader: () => reader,
    pipeline: { pageAttempts: 1 },
  });
});
after(() => h.close());

test("book, then marked, then model — and the model only where it's needed", async () => {
  const doc = await h.runBook({
    pdf: makePdf(["1", "2", "3"]),
    nodes: [
      { id: "l1", name: "الدرس الأول", printed_pages: { from: 1, to: 1 } },
      { id: "l2", name: "الدرس الثاني", printed_pages: { from: 2, to: 2 } },
      {
        id: "key",
        name: "الإجابات",
        kind: "answer_key",
        printed_pages: { from: 3, to: 3 },
      },
    ],
  });

  assert.deepEqual(
    doc.questions.map((q) => [
      q.node_id,
      q.number,
      q.answer_source,
      q.correct,
      q.review_reason,
    ]),
    [
      ["l1", "١", "book", ["ب"], null],
      ["l1", "2", "marked", ["ج"], null],
      ["l1", "3", "model", ["د"], "model_answer"],
      ["l2", "1", "book", ["أ"], null],
      ["l2", "2", null, [], "no_answer"],
    ],
  );
  // No model call for a question the book or a mark already answered.
  assert.deepEqual(reader.solves.sort(), ["q_1_3", "q_2_2"]);
});
