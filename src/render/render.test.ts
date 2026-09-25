import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import sharp from "sharp";
import { makePdf } from "../../test/pdf.ts";
import { normalisePhoto, pageCount, renderPage } from "./render.ts";

let dir: string;
let pdf: string;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "render-test-"));
  pdf = join(dir, "book.pdf");
  await writeFile(pdf, makePdf(["one", "two", "three"]));
});
after(() => rm(dir, { recursive: true, force: true }));

test("counts pages and renders one page to a ~200 DPI PNG", async () => {
  assert.equal(await pageCount(pdf), 3);
  const page = await renderPage(pdf, 2);
  // Letter size at 200 DPI.
  assert.equal(page.width, 1700);
  assert.equal(page.height, 2200);
  assert.deepEqual([...page.png.subarray(1, 4)], [...Buffer.from("PNG")]);
});

test("a file that isn't a PDF is refused", async () => {
  const junk = join(dir, "junk.pdf");
  await writeFile(junk, "not a pdf");
  await assert.rejects(pageCount(junk));
  await assert.rejects(renderPage(junk, 1), /could not render page 1/);
});

test("a photo becomes an upright PNG", async () => {
  const jpeg = await sharp({
    create: { width: 300, height: 400, channels: 3, background: "white" },
  })
    .jpeg()
    .toBuffer();
  const page = await normalisePhoto(jpeg);
  assert.equal(page.width, 300);
  assert.equal(page.height, 400);
});
