import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { writeCorrectionSheet } from "./sheet.ts";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "engines-golden-"));
  const book = join(root, "physics-g10");
  await mkdir(join(book, "truth"), { recursive: true });
  await writeFile(
    join(book, "manifest.json"),
    JSON.stringify({
      book: "physics-g10",
      title: "الفيزياء",
      pages: [
        { id: "p011", pdf_page: 11, image: "p011.png" },
        { id: "p012", pdf_page: 12, image: "p012.jpg" },
      ],
    }),
  );
  await writeFile(
    join(book, "truth", "p011.json"),
    JSON.stringify({
      status: "draft",
      pdf_page: 11,
      printed_page: 7,
      stimuli: [],
      questions: [],
      explanation: [
        {
          heading: "</textarea><script>alert(1)</script>",
          markdown: "a < b & c",
          crop: null,
        },
      ],
    }),
  );
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("writeCorrectionSheet", () => {
  test("shows each page image next to its draft truth", async () => {
    const path = await writeCorrectionSheet(root, "physics-g10");
    const html = await readFile(path, "utf8");

    assert.equal(path, join(root, "physics-g10", "sheet.html"));
    // Images are linked relative to the sheet, never embedded.
    assert.match(html, /<img[^>]+src="images\/p011\.png"/);
    assert.match(html, /<img[^>]+src="images\/p012\.jpg"/);
    assert.doesNotMatch(html, /data:image/);
    assert.match(html, /&quot;printed_page&quot;: 7/);
  });

  test("escapes truth text so it can't break out of the editor", async () => {
    const html = await readFile(
      await writeCorrectionSheet(root, "physics-g10"),
      "utf8",
    );

    assert.doesNotMatch(html, /<script>alert/);
    assert.match(html, /&lt;\/textarea&gt;&lt;script&gt;/);
    assert.match(html, /a &lt; b &amp; c/);
  });

  test("shows a broken truth file as it is, with the error, for the owner to fix", async () => {
    await writeFile(
      join(root, "physics-g10", "truth", "p012.json"),
      '{ "status": "corrected", ',
    );

    const html = await readFile(
      await writeCorrectionSheet(root, "physics-g10"),
      "utf8",
    );

    assert.match(html, /data-status="invalid"/);
    assert.match(html, /\{ &quot;status&quot;: &quot;corrected&quot;, </);
    assert.match(html, /class="message error"[^>]*>[^<]*p012\.json/);
  });

  test("gives an undrafted page an empty draft to fill in", async () => {
    const html = await readFile(
      await writeCorrectionSheet(root, "physics-g10"),
      "utf8",
    );

    assert.match(html, /&quot;pdf_page&quot;: 12/);
  });
});
