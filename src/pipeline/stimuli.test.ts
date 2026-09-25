// E-10: shared passages and diagrams are stored once and linked from their
// questions; diagrams get a crop of the page image behind a signed URL.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { startHarness, type Harness } from "../../test/harness.ts";
import { mcq, modelBlock, page } from "../../test/model.ts";
import { makePdf } from "../../test/pdf.ts";
import { scriptedReader } from "../reading/scripted.ts";

const reader = scriptedReader({
  pages: {
    1: page("1", [
      modelBlock({
        kind: "passage",
        text: "Read the passage and answer questions 1–3. The river…",
        stimulus_kind: "passage",
        covers: { from: "1", to: "3" },
      }),
      mcq("1", "What is the river's name?", ["a", "b", "c", "d"]),
      mcq("2", "Where does it start?", ["a", "b", "c", "d"]),
      mcq("3", "Why is it important?", ["a", "b", "c", "d"]),
      mcq("4", "Unrelated vocabulary question", ["a", "b", "c", "d"]),
    ]),
    2: page("2", [
      modelBlock({
        kind: "passage",
        text: "Figure 1: a circuit",
        stimulus_kind: "diagram",
        label: "Figure 1",
        box_2d: [100, 100, 400, 900],
      }),
      {
        ...mcq("5", "Which bulb is brighter?", ["a", "b"]),
        stimulus_label: "use figure 1",
        needs_figure: true,
      },
      {
        ...mcq("6", "What is the current?", ["a", "b"]),
        stimulus_label: "Figure 1",
        needs_figure: true,
      },
      { ...mcq("7", "Label the diagram", ["a", "b"]), needs_figure: true },
    ]),
  },
});

let h: Harness;
before(async () => {
  h = await startHarness({ reader: () => reader });
});
after(() => h.close());

test("one stimulus per passage or diagram, linked from its questions", async () => {
  const doc = await h.runBook({
    pdf: makePdf(["1", "2"]),
    nodes: [{ id: "l1", name: "l1", printed_pages: { from: 1, to: 2 } }],
  });

  assert.deepEqual(
    doc.stimuli.map((s) => [s.id, s.kind, s.image === null]),
    [
      ["s_1_0", "passage", true],
      ["s_2_0", "diagram", false],
    ],
  );
  assert.deepEqual(
    doc.questions.map((q) => [q.number, q.stimulus_id, q.review_reason]),
    [
      ["1", "s_1_0", null],
      ["2", "s_1_0", null],
      ["3", "s_1_0", null],
      ["4", null, null],
      ["5", "s_2_0", null],
      ["6", "s_2_0", null],
      ["7", null, "image_unreadable"],
    ],
  );
  assert.deepEqual(
    doc.failures.map((f) => [f.reason, f.locator.pdf_page]),
    [["image_unreadable", 2]],
  );

  // The diagram's crop is served from its signed URL.
  const url = doc.stimuli[1]?.image?.url;
  assert.ok(url);
  const crop = await h.app.request(url.replace("http://engines.test", ""));
  assert.equal(crop.status, 200);
  assert.equal(crop.headers.get("content-type"), "image/png");
});
