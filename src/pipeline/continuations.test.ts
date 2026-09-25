// E-09: a passage or question running onto the next page is re-read with both
// pages and joined; an unpaired flag is flagged or failed, never lost.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { startHarness, type Harness } from "../../test/harness.ts";
import { mcq, modelBlock, page } from "../../test/model.ts";
import { makePdf } from "../../test/pdf.ts";
import { scriptedReader } from "../reading/scripted.ts";

const reader = scriptedReader({
  pages: {
    1: page("1", [
      mcq("1", "قبل النص"),
      modelBlock({
        kind: "passage",
        text: "النص يبدأ",
        stimulus_kind: "passage",
        continues: true,
      }),
    ]),
    2: page("2", [
      modelBlock({
        kind: "passage",
        text: "ويكمل هنا",
        stimulus_kind: "passage",
        continued_from: true,
      }),
      mcq("2", "عن النص"),
      { ...mcq("3", "سؤال مقطوع", ["أ"]), continues: true },
    ]),
    3: page("3", [modelBlock({ kind: "neither", text: "صورة" })]),
    4: page("4", [{ ...mcq("4", "خيارات تكمل؟"), continues: true }]),
    5: page("5", [{ ...mcq("5", "بقية"), continued_from: true }]),
  },
  joins: {
    1: modelBlock({
      kind: "passage",
      text: "النص يبدأ ويكمل هنا",
      stimulus_kind: "passage",
    }),
    // No scripted join for page 4: that re-read fails and both halves stay flagged.
  },
});

let h: Harness;
before(async () => {
  h = await startHarness({
    reader: () => reader,
    pipeline: { pageAttempts: 1 },
  });
});
after(() => h.close());

test("flagged pairs are re-read together and joined; unpaired flags are never lost", async () => {
  const doc = await h.runBook({
    pdf: makePdf(["1", "2", "3", "4", "5"]),
    nodes: [{ id: "l1", name: "l1", printed_pages: { from: 1, to: 5 } }],
  });

  // Only the flagged pairs (1–2 and 4–5) cost a second call.
  assert.deepEqual([...reader.pairReads].sort(), [1, 4]);
  assert.equal(reader.reads.length, 5);

  assert.deepEqual(
    doc.stimuli.map((s) => [s.text, s.pages]),
    [["النص يبدأ ويكمل هنا", [1]]],
  );
  assert.deepEqual(
    doc.questions.map((q) => [q.number, q.review_reason]),
    [
      ["1", null],
      ["2", null],
      ["4", "cut_off"],
      ["5", "cut_off"],
    ],
  );
  // Question 3 lost its other options at the page break and nothing continues it.
  assert.deepEqual(
    doc.failures.map((f) => [f.reason, f.locator.pdf_page]),
    [["incomplete_question", 2]],
  );
});
