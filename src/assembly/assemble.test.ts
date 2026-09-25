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
  });
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

  test("blocks that are neither are counted, not dropped", () => {
    const result = run({
      1: page("1", [modelBlock({ kind: "neither" }), mcq("1", "a")]),
    });
    assert.equal(result.skipped.neither, 1);
    assert.equal(result.questions.length, 1);
  });
});
