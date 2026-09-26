import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { mcq, modelBlock, page } from "../../test/model.ts";
import { toBlock, toPageReading, type ModelPage } from "../reading/blocks.ts";
import { applyJoins, findPairs } from "./continuations.ts";

const readings = (pages: Record<number, ModelPage>) =>
  Object.entries(pages).map(([pdf, p]) => toPageReading(Number(pdf), p));

const tail = modelBlock({
  kind: "passage",
  text: "النص يبدأ",
  continues: true,
  stimulus_kind: "passage",
});
const head = modelBlock({
  kind: "passage",
  text: "ويكمل هنا",
  continued_from: true,
  stimulus_kind: "passage",
});

describe("findPairs", () => {
  test("a block running off one page pairs with the continuation at the top of the next", () => {
    const { pairs, unpaired } = findPairs(
      readings({
        40: page("40", [mcq("1", "a"), tail]),
        41: page("41", [head, mcq("2", "b")]),
      }),
    );
    assert.deepEqual(
      pairs.map((p) => [p.first.id, p.second.id]),
      [["p40#1", "p41#0"]],
    );
    assert.deepEqual(unpaired, []);
  });

  test("a flag without a partner is unpaired, never guessed", () => {
    const { pairs, unpaired } = findPairs(
      readings({
        40: page("40", [tail]),
        41: page("41", [mcq("2", "no continuation flag")]),
        50: page("50", [head]),
      }),
    );
    assert.deepEqual(pairs, []);
    assert.deepEqual(unpaired.map((b) => b.id).sort(), ["p40#0", "p50#0"]);
  });

  test("the next page must have been read", () => {
    const { pairs, unpaired } = findPairs(readings({ 40: page("40", [tail]) }));
    assert.deepEqual(pairs, []);
    assert.deepEqual(
      unpaired.map((b) => b.id),
      ["p40#0"],
    );
  });

  test("a block spanning three pages joins its first two pages only; the rest stays flagged", () => {
    const middle = modelBlock({
      kind: "passage",
      text: "وسط",
      continued_from: true,
      continues: true,
    });
    const { pairs, unpaired } = findPairs(
      readings({
        1: page("1", [tail]),
        2: page("2", [middle]),
        3: page("3", [head]),
      }),
    );
    assert.deepEqual(
      pairs.map((p) => [p.first.id, p.second.id]),
      [["p1#0", "p2#0"]],
    );
    assert.deepEqual(
      unpaired.map((b) => b.id),
      ["p3#0"],
    );
  });
});

describe("applyJoins", () => {
  test("the joined block replaces both halves, on the page it starts on", () => {
    const pages = readings({
      40: page("40", [mcq("1", "a"), tail]),
      41: page("41", [head, mcq("2", "b")]),
    });
    const joined = toBlock(
      40,
      1,
      modelBlock({
        kind: "passage",
        text: "النص يبدأ ويكمل هنا",
        stimulus_kind: "passage",
      }),
    );

    const out = applyJoins(pages, [
      { replaces: ["p40#1", "p41#0"], block: joined },
    ]);

    assert.deepEqual(
      out.map((p) => p.blocks.map((b) => [b.id, b.text])),
      [
        [
          ["p40#0", "a"],
          ["p40#1", "النص يبدأ ويكمل هنا"],
        ],
        [["p41#1", "b"]],
      ],
    );
    assert.equal(out[0]?.blocks[1]?.continues, false);
  });
});
