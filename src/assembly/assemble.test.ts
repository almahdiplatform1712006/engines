import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { mcq, modelBlock, page } from "../../test/model.ts";
import { n } from "../../test/tree.ts";
import { IDENTITY } from "../offset/segments.ts";
import { toPageReading, type ModelPage } from "../reading/blocks.ts";
import { assemble, type AssemblyInput } from "./assemble.ts";

function run(
  pages: Record<number, ModelPage>,
  overrides: Partial<AssemblyInput> = {},
) {
  return assemble({
    type: "questions",
    tree: [
      n("unit", 1, 5, [
        n("l1", 1, 2, [], { external_ref: "lesson:1" }),
        n("l2", 3, 4),
      ]),
    ],
    segments: IDENTITY,
    pages: Object.entries(pages).map(([pdf, p]) =>
      toPageReading(Number(pdf), p),
    ),
    failedPages: [],
    ...overrides,
  }).result;
}

describe("placement (E-05)", () => {
  test("the deepest node whose range contains the page wins", () => {
    const result = run({
      1: page("1", [mcq("1", "a")]),
      3: page("3", [mcq("2", "b")]),
      5: page("5", [mcq("3", "unit revision")]),
    });
    assert.deepEqual(
      result.questions.map((q) => [
        q.number,
        q.node_id,
        q.node_path.join(" > "),
      ]),
      [
        ["1", "l1", "unit > l1"],
        ["2", "l2", "unit > l2"],
        ["3", "unit", "unit"],
      ],
    );
    assert.equal(result.questions[0]?.external_ref, "lesson:1");
    assert.deepEqual(result.failures, []);
  });

  test("a page outside every range is an unmapped_page failure", () => {
    const result = run({ 7: page("7", [mcq("1", "a"), mcq("2", "b")]) });
    assert.equal(result.questions.length, 0);
    assert.deepEqual(
      result.failures.map((f) => [f.reason, f.locator.pdf_page]),
      [["unmapped_page", 7]],
    );
  });

  test("a page that failed every retry is part_failed", () => {
    const result = run(
      {},
      { failedPages: [{ pdf_page: 2, detail: "timeout" }] },
    );
    assert.deepEqual(
      result.failures.map((f) => f.reason),
      ["part_failed"],
    );
  });

  test("a page whose printed number contradicts the offset is held as offset_break", () => {
    const result = run({
      1: page("1", [mcq("1", "a")]),
      2: page("7", [mcq("2", "b")]),
      3: page("3", [mcq("3", "c")]),
    });
    assert.deepEqual(
      result.questions.map((q) => q.number),
      ["1", "3"],
    );
    assert.deepEqual(
      result.failures.map((f) => [f.reason, f.locator.pdf_page]),
      [["offset_break", 2]],
    );
  });

  test("placement goes through the offset", () => {
    const result = run(
      { 7: page("5", [mcq("1", "a")]) },
      { segments: [{ printed_from: 1, pdf_from: 3, confirmed: true }] },
    );
    assert.deepEqual(
      result.questions.map((q) => [q.node_id, q.locator]),
      [["unit", { pdf_page: 7, printed_page: 5 }]],
    );
  });

  test("no block disappears: each is delivered, counted as skipped, or in a failure", () => {
    const pages = {
      1: page("1", [
        modelBlock({ kind: "heading", text: "الدرس الأول" }),
        modelBlock({ kind: "explanation", text: "شرح" }),
        modelBlock({ kind: "passage", text: "نص", stimulus_kind: "passage" }),
        mcq("1", "a"),
        modelBlock({ kind: "neither" }),
      ]),
      9: page("9", [mcq("2", "outside"), modelBlock({ kind: "neither" })]),
    };
    const questions = run(pages, { type: "questions" });
    assert.equal(questions.questions.length, 1);
    assert.equal(questions.stimuli.length, 1);
    // A questions document counts the heading and the explanation as off_type.
    assert.deepEqual(questions.skipped, { neither: 2, off_type: 2 });
    assert.deepEqual(
      questions.failures.map((f) => f.reason),
      ["unmapped_page"],
    );

    const explanation = run(pages, { type: "explanation" });
    assert.equal(explanation.questions.length, 0);
    assert.deepEqual(explanation.skipped, { neither: 2, off_type: 2 });
  });

  test("explanation: heading-bounded chunks under their nodes, questions skipped", () => {
    const result = run(
      {
        1: page("1", [
          modelBlock({ kind: "heading", text: "القانون الأول" }),
          modelBlock({ kind: "explanation", text: "يبقى الجسم ساكنا $F = 0$" }),
          modelBlock({
            kind: "passage",
            stimulus_kind: "diagram",
            text: "شكل",
            box_2d: [100, 100, 300, 300],
          }),
          mcq("1", "سؤال"),
        ]),
        3: page("3", [
          modelBlock({ kind: "explanation", text: "شرح الدرس الثاني" }),
        ]),
      },
      { type: "explanation" },
    );
    assert.deepEqual(
      result.explanation.map((c) => [
        c.node_id,
        c.heading,
        c.figures.length,
        c.pages.pdf,
      ]),
      [
        ["l1", "القانون الأول", 1, [1]],
        ["l2", "l2", 0, [3]],
      ],
    );
    assert.equal(result.questions.length, 0);
    assert.equal(result.skipped.off_type, 1);
  });

  test("explanation: a section holding only a diagram keeps it as a figure", () => {
    const result = run(
      {
        1: page("1", [
          modelBlock({ kind: "heading", text: "الشكل" }),
          modelBlock({
            kind: "passage",
            stimulus_kind: "diagram",
            text: "دائرة",
            box_2d: [0, 0, 500, 500],
          }),
        ]),
      },
      { type: "explanation" },
    );
    assert.deepEqual(
      result.explanation.map((c) => [c.heading, c.figures.length]),
      [["الشكل", 1]],
    );
  });

  test("both: a diagram a question uses is a stimulus; another is a figure of its section", () => {
    const result = run(
      {
        1: page("1", [
          modelBlock({ kind: "explanation", text: "شرح" }),
          modelBlock({
            kind: "passage",
            stimulus_kind: "diagram",
            label: "شكل 1",
            text: "",
            box_2d: [0, 0, 300, 300],
          }),
          modelBlock({ kind: "heading", text: "تمارين" }),
          modelBlock({
            kind: "passage",
            stimulus_kind: "diagram",
            label: "شكل 2",
            text: "",
            box_2d: [400, 0, 700, 300],
          }),
          { ...mcq("1", "سؤال"), stimulus_label: "شكل 2" },
        ]),
      },
      { type: "both" },
    );
    assert.deepEqual(
      result.stimuli.map((s) => s.id),
      ["s_1_3"],
    );
    assert.equal(result.questions[0]?.stimulus_id, "s_1_3");
    assert.deepEqual(
      result.explanation.map((c) => c.figures.length),
      [1],
    );
  });

  test("both keeps questions and explanation apart", () => {
    const result = run(
      {
        1: page("1", [
          modelBlock({ kind: "explanation", text: "شرح" }),
          mcq("1", "سؤال"),
        ]),
      },
      { type: "both" },
    );
    assert.equal(result.questions.length, 1);
    assert.equal(result.explanation.length, 1);
    assert.equal(result.skipped.off_type, 0);
  });

  test("blocks that are neither are counted, not dropped", () => {
    const result = run({
      1: page("1", [modelBlock({ kind: "neither" }), mcq("1", "a")]),
    });
    assert.equal(result.skipped.neither, 1);
    assert.equal(result.questions.length, 1);
  });
});
