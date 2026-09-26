import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { chunkSections, splitMarkdown, type Section } from "./chunks.ts";

const section = (
  heading: string,
  markdown: string,
  fields: Partial<Section> = {},
): Section => ({
  id: `c_${heading}`,
  node_id: "l1",
  node_path: ["u1", "l1"],
  external_ref: null,
  heading,
  markdown,
  math_direction: null,
  figures: [],
  pdf_pages: [1],
  printed_pages: [1],
  ...fields,
});

const words = (n: number, word = "كلمة") =>
  Array.from({ length: n }, () => word).join(" ");
const options = { maxTokens: 50, minTokens: 10 };

describe("splitMarkdown", () => {
  test("splits at paragraph breaks, packing paragraphs up to the limit", () => {
    const paragraphs = [words(20), words(20), words(20)];
    const pieces = splitMarkdown(paragraphs.join("\n\n"), 50);
    assert.equal(pieces.length, 2);
    assert.equal(pieces.join("\n\n"), paragraphs.join("\n\n"));
  });

  test("never splits inside $$…$$, even across blank lines", () => {
    const display = "$$\nF = ma\n\n\\\\ a = \\frac{F}{m}\n$$";
    const text = [words(30), display, words(30)].join("\n\n");
    const pieces = splitMarkdown(text, 40);
    assert.ok(
      pieces.some((p) => p.includes(display)),
      "the equation stays whole",
    );
  });

  test("never splits inside a table", () => {
    const table = ["| a | b |", "|---|---|", "| 1 | 2 |", "", "| 3 | 4 |"].join(
      "\n",
    );
    const pieces = splitMarkdown([words(35), table].join("\n\n"), 40);
    assert.ok(
      pieces.some((p) => p.includes("| 1 | 2 |") && p.includes("| a | b |")),
    );
  });
});

describe("chunkSections: tiny first sections", () => {
  test("a tiny first section of a node merges forward into the next", () => {
    const chunks = chunkSections(
      [section("مقدمة", words(3)), section("أ", words(20))],
      options,
    );
    assert.deepEqual(
      chunks.map((c) => c.heading),
      ["مقدمة"],
    );
    assert.ok(chunks[0]?.markdown.includes("### مقدمة"));
  });
});

describe("chunkSections", () => {
  test("one chunk per section, with the heading breadcrumb", () => {
    const [chunk] = chunkSections(
      [section("قانون نيوتن الثاني", words(20))],
      options,
    );
    assert.ok(chunk);
    assert.equal(chunk.heading, "قانون نيوتن الثاني");
    assert.ok(chunk.markdown.startsWith("> u1 › l1 › قانون نيوتن الثاني\n\n"));
  });

  test("an oversized section is split, the breadcrumb repeated in each piece", () => {
    const chunks = chunkSections(
      [section("طويل", [words(30), words(30), words(30)].join("\n\n"))],
      options,
    );
    assert.equal(chunks.length, 3);
    for (const chunk of chunks)
      assert.ok(chunk.markdown.startsWith("> u1 › l1 › طويل"));
    assert.deepEqual(
      chunks.map((c) => c.id),
      ["c_طويل", "c_طويل_2", "c_طويل_3"],
    );
  });

  test("tiny sections merge with the one before, only within the same node", () => {
    const chunks = chunkSections(
      [
        section("أ", words(20)),
        section("ب", words(3)),
        section("ج", words(3), { node_id: "l2", node_path: ["u1", "l2"] }),
      ],
      options,
    );
    assert.deepEqual(
      chunks.map((c) => [c.node_id, c.heading]),
      [
        ["l1", "أ"],
        ["l2", "ج"],
      ],
    );
    assert.ok(chunks[0]?.markdown.includes("### ب"));
  });
});
