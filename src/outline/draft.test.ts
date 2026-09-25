import assert from "node:assert/strict";
import { test } from "node:test";
import { draftTree, type ContentsEntry } from "./draft.ts";

const entry = (
  name: string,
  depth: number,
  from: number | null,
  more: Partial<ContentsEntry> = {},
): ContentsEntry => ({
  name,
  depth,
  level: null,
  from,
  to: null,
  answerKey: false,
  ...more,
});

const ranges = (nodes: ReturnType<typeof draftTree>): unknown =>
  nodes.map((n) => [
    n.name,
    n.printed_pages ? [n.printed_pages.from, n.printed_pages.to] : null,
    ...(n.children && n.children.length > 0 ? [ranges(n.children)] : []),
  ]);

test("start pages only: each node ends before the next one starts", () => {
  const tree = draftTree([
    [
      entry("الوحدة الأولى", 1, 5, { level: "الوحدة" }),
      entry("الدرس الأول", 2, 5),
      entry("الدرس الثاني", 2, 12),
      entry("الوحدة الثانية", 1, 30),
      entry("الدرس الثالث", 2, 30),
      entry("الدرس الرابع", 2, 41),
    ],
  ]);
  assert.deepEqual(ranges(tree), [
    [
      "الوحدة الأولى",
      [5, 29],
      [
        ["الدرس الأول", [5, 11]],
        ["الدرس الثاني", [12, 29]],
      ],
    ],
    [
      "الوحدة الثانية",
      [30, 41],
      [
        ["الدرس الثالث", [30, 40]],
        // The book's last node: its end isn't on the contents page.
        ["الدرس الرابع", null],
      ],
    ],
  ]);
  assert.equal(tree[0]?.level, "الوحدة");
});

test("ranges the page gives are kept", () => {
  const tree = draftTree([
    [entry("Lesson 1", 1, 3, { to: 9 }), entry("Lesson 2", 1, 10, { to: 20 })],
  ]);
  assert.deepEqual(ranges(tree), [
    ["Lesson 1", [3, 9]],
    ["Lesson 2", [10, 20]],
  ]);
});

test("entries run on across contents pages", () => {
  const tree = draftTree([
    [entry("Unit 1", 1, 1), entry("Lesson 1", 2, 1)],
    [entry("Lesson 2", 2, 8), entry("Unit 2", 1, 15, { to: 30 })],
  ]);
  assert.deepEqual(ranges(tree), [
    [
      "Unit 1",
      [1, 14],
      [
        ["Lesson 1", [1, 7]],
        ["Lesson 2", [8, 14]],
      ],
    ],
    ["Unit 2", [15, 30]],
  ]);
});

test("two nodes starting on one page share it", () => {
  const tree = draftTree([
    [entry("A", 1, 4), entry("B", 1, 4), entry("C", 1, 9, { to: 9 })],
  ]);
  assert.deepEqual(ranges(tree), [
    ["A", [4, 4]],
    ["B", [4, 8]],
    ["C", [9, 9]],
  ]);
});

test("a unit without a page spans its lessons; skipped depths nest under the nearest", () => {
  const tree = draftTree([
    [
      entry("Unit", 1, null),
      entry("Lesson a", 3, 2),
      entry("Lesson b", 3, 6, { to: 9 }),
      entry("Answers", 1, 100, { answerKey: true }),
    ],
  ]);
  assert.deepEqual(ranges(tree), [
    [
      "Unit",
      [2, 99],
      [
        ["Lesson a", [2, 5]],
        ["Lesson b", [6, 9]],
      ],
    ],
    ["Answers", null],
  ]);
  assert.equal(tree[1]?.kind, "answer_key");
});

test("blank names are dropped, nothing else is", () => {
  const tree = draftTree([[entry(" ", 1, 1), entry("Only", 1, null)]]);
  assert.deepEqual(ranges(tree), [["Only", null]]);
});
