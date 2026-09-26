import assert from "node:assert/strict";
import { test } from "node:test";
import { makePdf } from "../../test/pdf.ts";
import { pageLabels } from "./labels.ts";

test("reads page labels a PDF sets", async () => {
  const pdf = makePdf(["a", "b", "c", "d"], {
    labels: "0 << /S /r >> 2 << /S /D >>",
  });
  assert.deepEqual(await pageLabels(pdf), ["i", "ii", "1", "2"]);
});

test("no labels, or not a PDF, gives null", async () => {
  assert.equal(await pageLabels(makePdf(["a"])), null);
  assert.equal(await pageLabels(Buffer.from("junk")), null);
});
