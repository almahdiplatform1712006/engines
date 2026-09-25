import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { OutlineNode, OutlineNodeInput } from "../contract/outline.ts";
import { normaliseTree, validateOutline } from "./tree.ts";

function node(
  id: string,
  from: number | null,
  to: number | null,
  children: OutlineNode[] = [],
  kind: OutlineNode["kind"] = "content",
): OutlineNode {
  return {
    id,
    name: id,
    level: null,
    printed_pages: from === null || to === null ? null : { from, to },
    kind,
    external_ref: null,
    children,
  };
}

function codes(nodes: OutlineNode[]) {
  const { errors, warnings } = validateOutline(nodes);
  return {
    errors: errors.map((i) => `${i.code}:${i.node_id ?? "-"}`),
    warnings: warnings.map((i) => `${i.code}:${i.node_id ?? "-"}`),
  };
}

describe("validateOutline", () => {
  test("a well-formed two-level tree has no issues", () => {
    const tree = [
      node("u1", 1, 40, [node("l1", 1, 20), node("l2", 20, 40)]),
      node("key", 41, 50, [], "answer_key"),
    ];
    assert.deepEqual(codes(tree), { errors: [], warnings: [] });
  });

  test("every node needs a range", () => {
    assert.deepEqual(codes([node("u1", 1, 10, [node("l1", null, null)])]), {
      errors: ["missing_range:l1"],
      warnings: [],
    });
  });

  test("from must not be after to", () => {
    assert.deepEqual(codes([node("u1", 10, 5)]).errors, ["inverted_range:u1"]);
  });

  test("a child outside its parent blocks confirmation", () => {
    assert.deepEqual(codes([node("u1", 1, 10, [node("l1", 8, 12)])]).errors, [
      "outside_parent:l1",
    ]);
  });

  test("siblings may share one boundary page but no more", () => {
    assert.deepEqual(codes([node("a", 1, 10), node("b", 10, 20)]).errors, []);
    assert.deepEqual(codes([node("a", 1, 10), node("b", 9, 20)]).errors, [
      "sibling_overlap:b",
    ]);
  });

  test("gaps between children are warnings, not errors", () => {
    assert.deepEqual(
      codes([node("u", 1, 30, [node("a", 1, 10), node("b", 15, 30)])]),
      { errors: [], warnings: ["gap:b"] },
    );
  });

  test("at most one answer-key node", () => {
    assert.deepEqual(
      codes([
        node("k1", 1, 2, [], "answer_key"),
        node("k2", 3, 4, [], "answer_key"),
      ]).errors,
      ["multiple_answer_keys:k2"],
    );
  });

  test("node ids are unique across the tree", () => {
    assert.deepEqual(codes([node("a", 1, 5, [node("a", 1, 2)])]).errors, [
      "duplicate_id:a",
    ]);
  });
});

describe("normaliseTree", () => {
  test("fills defaults and gives new nodes ids, keeping the ones sent", () => {
    const input: OutlineNodeInput[] = [
      {
        id: "unit_1",
        name: " الوحدة الأولى ",
        external_ref: "unit:9",
        children: [{ name: "الدرس الأول", printed_pages: { from: 3, to: 9 } }],
      },
    ];
    const [unit] = normaliseTree(input);
    assert.ok(unit);
    assert.equal(unit.id, "unit_1");
    assert.equal(unit.name, "الوحدة الأولى");
    assert.equal(unit.kind, "content");
    assert.equal(unit.printed_pages, null);
    assert.equal(unit.external_ref, "unit:9");
    const [lesson] = unit.children;
    assert.ok(lesson);
    assert.match(lesson.id, /^n_[A-Za-z0-9]+$/);
    assert.equal(lesson.external_ref, null);
    assert.deepEqual(lesson.printed_pages, { from: 3, to: 9 });
  });
});
