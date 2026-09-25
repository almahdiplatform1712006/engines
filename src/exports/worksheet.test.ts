import assert from "node:assert/strict";
import { test } from "node:test";
import { chunk, question, result, stimulus } from "../../test/result.ts";
import { n } from "../../test/tree.ts";
import { buildWorksheet } from "./worksheet.ts";

const tree = [
  n("u1", 1, 10, [n("l1", 1, 5), n("l2", 6, 10)]),
  n("empty", 11, 12),
];

test("headings in tree order, numbered questions, a stimulus once before its questions", () => {
  const sheet = buildWorksheet({
    title: "كتاب",
    language: null,
    tree,
    withExplanation: true,
    result: result({
      stimuli: [stimulus("s1", "l2")],
      questions: [
        question("a", "l1"),
        question("b", "l2", { stimulus_id: "s1" }),
        question("c", "l2", {
          stimulus_id: "s1",
          type: "fill_blank",
          options: [],
          correct: [],
          accepted_answers: ["9.8"],
        }),
      ],
      explanation: [chunk("c1", "l1")],
    }),
  });

  assert.equal(sheet.lang, "ar");
  assert.equal(sheet.rtl, true);
  assert.deepEqual(
    sheet.sections.map((s) => [
      s.nodeId,
      s.depth,
      s.entries.map((e) =>
        e.kind === "question" ? `q${String(e.number)}` : e.kind,
      ),
    ]),
    [
      ["u1", 0, []],
      ["l1", 1, ["explanation", "q1"]],
      ["l2", 1, ["stimulus", "q2", "q3"]],
    ],
  );
  assert.deepEqual(sheet.answerKey, [
    { number: 1, answer: "أ" },
    { number: 2, answer: "أ" },
    { number: 3, answer: "9.8" },
  ]);
});

test("explanation only for entitled organisations", () => {
  const sheet = buildWorksheet({
    title: "Book",
    language: "en",
    tree,
    withExplanation: false,
    result: result({ explanation: [chunk("c1", "l1")] }),
  });
  assert.deepEqual(sheet.sections, []);
  assert.equal(sheet.rtl, false);
});
