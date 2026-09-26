import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { mcq, modelBlock, page } from "../../test/model.ts";
import { n } from "../../test/tree.ts";
import { IDENTITY } from "../offset/segments.ts";
import { toPageReading, type ModelPage } from "../reading/blocks.ts";
import { place } from "./placement.ts";
import { indexTree } from "./tree-index.ts";

const heading = (text: string) => modelBlock({ kind: "heading", text });

// Unit 1 (pp. 1–10) holds lesson 1 (1–4) and lesson 2 (4–8); pages 9–10 are
// unit revision. Unit 2 (10–20) starts on unit 1's last page and holds
// lesson 3 (10–20).
const tree = [
  n(
    "u1",
    1,
    10,
    [
      n("l1", 1, 4, [], { name: "الدرس الأول: الحركة" }),
      n("l2", 4, 8, [], { name: "الدرس الثاني: القوة" }),
    ],
    { name: "الوحدة الأولى" },
  ),
  n("u2", 10, 20, [n("l3", 10, 20, [], { name: "الدرس الثالث: الطاقة" })], {
    name: "الوحدة الثانية",
  }),
];

function run(pages: Record<number, ModelPage>) {
  const readings = Object.entries(pages).map(([pdf, p]) =>
    toPageReading(Number(pdf), p),
  );
  const { placed, unmapped } = place(indexTree(tree), IDENTITY, readings);
  return {
    rows: placed.map((p) => [
      p.block.question?.number ?? p.block.text,
      p.node.node.id,
      p.flag,
    ]),
    tags: placed.map((p) => p.idea_tag),
    unmapped,
  };
}

describe("place", () => {
  const cases: {
    name: string;
    pages: Record<number, ModelPage>;
    want: (string | null)[][];
  }[] = [
    {
      name: "the deepest node whose range contains the page wins",
      pages: { 2: page("2", [mcq("1", "a")]) },
      want: [["1", "l1", null]],
    },
    {
      name: "a page inside the unit but no lesson files under the unit",
      pages: { 9: page("9", [mcq("1", "revision")]) },
      want: [["1", "u1", null]],
    },
    {
      name: "a shared page splits at the later lesson's heading, in reading order",
      pages: {
        4: page("4", [
          mcq("7", "end of lesson 1"),
          heading("الدَّرسُ الثاني - القوة"),
          mcq("1", "start of lesson 2"),
        ]),
      },
      want: [
        ["7", "l1", null],
        ["الدَّرسُ الثاني - القوة", "l2", null],
        ["1", "l2", null],
      ],
    },
    {
      name: "heading not found: the earlier node, flagged",
      pages: { 4: page("4", [mcq("7", "a"), mcq("8", "b")]) },
      want: [
        ["7", "l1", "heading_not_found"],
        ["8", "l1", "heading_not_found"],
      ],
    },
    {
      name: "a page shared across units splits at the later unit's heading, into its deepest node",
      pages: {
        10: page("10", [
          mcq("9", "unit 1 revision"),
          heading("الوحدة الثانية"),
          mcq("1", "x"),
        ]),
      },
      want: [
        ["9", "u1", null],
        ["الوحدة الثانية", "l3", null],
        ["1", "l3", null],
      ],
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      assert.deepEqual(run(c.pages).rows, c.want);
    });
  }

  test("a page outside every range is unmapped, with its block count", () => {
    const { rows, unmapped } = run({
      30: page("30", [mcq("1", "a"), mcq("2", "b")]),
    });
    assert.deepEqual(rows, []);
    assert.deepEqual([...unmapped], [[30, 2]]);
  });

  test("idea_tag is the nearest sub-heading inside the lesson, across pages", () => {
    const { tags } = run({
      11: page("11", [
        heading("الدرس الثالث: الطاقة"),
        mcq("1", "a"),
        heading("طاقة الوضع"),
        mcq("2", "b"),
      ]),
      12: page("12", [mcq("3", "c")]),
    });
    assert.deepEqual(tags, [null, null, null, "طاقة الوضع", "طاقة الوضع"]);
  });
});
