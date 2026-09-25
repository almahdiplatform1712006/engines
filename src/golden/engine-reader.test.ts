import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { mcq, modelBlock, page } from "../../test/model.ts";
import { scriptedReader } from "../reading/scripted.ts";
import { goldenReader } from "./engine-reader.ts";
import { printedPageAccuracy, questionRecall } from "./scorers.ts";
import { emptyPage } from "./truth.ts";

test("Engines' reader runs under the golden tools, and its printed page number is scored", async () => {
  const dir = await mkdtemp(join(tmpdir(), "golden-engine-"));
  try {
    const image = join(dir, "p012.png");
    await writeFile(image, "png bytes");
    const reader = goldenReader("scripted", (record) =>
      scriptedReader({
        pages: {
          12: page("٨", [
            modelBlock({
              kind: "passage",
              text: "اقرأ النص",
              stimulus_kind: "passage",
            }),
            { ...mcq("1", "سؤال عن النص"), stimulus_label: "النص" },
          ]),
        },
        record,
      }),
    );

    const { content } = await reader.read({ path: image, pdf_page: 12 });

    assert.equal(content.printed_page, 8);
    assert.equal(content.questions[0]?.stimulus_id, content.stimuli[0]?.id);
    const truth = {
      ...emptyPage(12),
      printed_page: 8,
      questions: content.questions,
    };
    assert.deepEqual(printedPageAccuracy(truth, content), { num: 1, den: 1 });
    assert.deepEqual(questionRecall(truth, content), { num: 1, den: 1 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
