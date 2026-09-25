// E-17 in the browser: a confirmed tree → upload the book → confirm (and
// correct) the offset with thumbnails → progress → results. And a large
// upload that's cut off resumes where it stopped.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { Page } from "playwright-core";
import sharp from "sharp";
import { grantCredits } from "../../src/accounts/credits.ts";
import type { Document } from "../../src/contract/document.ts";
import { scriptedReader } from "../../src/reading/scripted.ts";
import {
  assertFitsWidth,
  signedIn,
  startPage,
  type PageHarness,
} from "../browser.ts";
import { mcq, page as printed } from "../model.ts";
import { makePdf } from "../pdf.ts";

// A six-page book: a cover and a blank, then printed pages 1–4. The quick
// pass misreads the numbers as PDF page numbers, so the proposed offset is
// wrong and the uploader corrects it: printed 1 = PDF 3.
const reader = scriptedReader({
  pages: {
    3: printed("1", [mcq("1", "سؤال الدرس الأول")]),
    4: printed("2", []),
    5: printed("3", [mcq("2", "سؤال الدرس الثاني")]),
    6: printed("4", []),
  },
  numbers: { 1: "1", 2: "2", 3: "3", 4: "4", 5: "5", 6: "6" },
});

let p: PageHarness;
let page: Page;
let orgId: string;
let dir: string;
before(async () => {
  p = await startPage({ reader: () => reader });
  ({ page, orgId } = await signedIn(p, "books@example.com"));
  await grantCredits(p.h.db, orgId, 1000, "test");
  dir = await mkdtemp(join(tmpdir(), "e2e-book-"));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
  await p.close();
});

const api = async <T>(method: string, path: string, body?: unknown) => {
  const response = await page.request.fetch(path, {
    method,
    headers: { "engines-organisation": orgId, origin: p.url },
    ...(body === undefined ? {} : { data: body }),
  });
  assert.ok(response.ok(), `${method} ${path}: ${await response.text()}`);
  return (await response.json()) as T;
};

test("confirmed tree → upload → offset corrected → progress → results", async () => {
  const outline = await api<{ id: string }>("POST", "/v1/outlines", {
    source: {
      type: "manual",
      nodes: [
        { id: "a", name: "الدرس الأول", printed_pages: { from: 1, to: 2 } },
        { id: "b", name: "الدرس الثاني", printed_pages: { from: 3, to: 4 } },
      ],
    },
  });
  await page.goto(`/o/${orgId}/outlines/${outline.id}?type=questions`);
  await page.getByRole("button", { name: "تأكيد الشجرة" }).click();
  await page.getByRole("link", { name: "التالي: رفع الكتاب" }).click();
  await page.waitForURL(/\/upload\/out_/);

  const file = join(dir, "book.pdf");
  await writeFile(file, makePdf(["cover", "blank", "p1", "p2", "p3", "p4"]));
  await page.locator('input[type="file"]').setInputFiles(file);
  await page.getByRole("button", { name: "رفع", exact: true }).click();
  await page.getByTestId("estimate").waitFor();
  const estimate = (await page.getByTestId("estimate").textContent()) ?? "";
  assert.match(estimate, /6 صفحة/, "the page count before starting");
  await assertFitsWidth(page);
  await page.getByRole("button", { name: "ابدأ المعالجة" }).click();
  await page.waitForURL(/\/documents\/doc_/);
  const documentId = /documents\/(doc_[^/?]+)/.exec(page.url())?.[1] ?? "";

  // The offset screen: the proposal, with two of the book's own pages.
  await page.getByText("أين تبدأ أرقام الصفحات المطبوعة؟").waitFor({
    timeout: 20_000,
  });
  const thumbs = page.locator(".thumbs img");
  await thumbs.first().waitFor();
  assert.ok((await thumbs.count()) >= 2);
  const loaded = await thumbs.evaluateAll((imgs) =>
    imgs.map(
      (img) => (img as unknown as { naturalWidth: number }).naturalWidth,
    ),
  );
  assert.ok(
    loaded.every((w) => w > 0),
    "the thumbnails are the pipeline's page images",
  );
  await assertFitsWidth(page);

  // Correct it: printed page 1 is PDF page 3 (typed in Arabic-Indic digits).
  const segment = page.getByTestId("segment").first();
  await segment.getByLabel("الصفحة المطبوعة").fill("١");
  await segment.getByLabel("صفحة الملف").fill("٣");
  await page.getByRole("button", { name: "تأكيد", exact: true }).click();

  await page.getByText("اكتمل").first().waitFor({ timeout: 30_000 });
  await page.getByRole("link", { name: "عرض النتائج" }).waitFor();
  await assertFitsWidth(page);

  const doc = await api<Document>("GET", `/v1/documents/${documentId}`);
  const byText = Object.fromEntries(
    doc.questions.map((q) => [q.text, q.node_id]),
  );
  assert.deepEqual(
    byText,
    {
      "سؤال الدرس الأول": "a",
      "سؤال الدرس الثاني": "b",
    },
    "the corrected offset decides the lesson",
  );

  // The books list shows it, in English too.
  await page.getByTestId("language").click();
  await page.goto(`/o/${orgId}/books`);
  await page.getByText("book", { exact: true }).waitFor();
  await page.getByText("Completed").first().waitFor();
  await assertFitsWidth(page);
  await page.getByTestId("language").click();
});

test("a large upload cut off by a reload resumes where it stopped", async () => {
  // About 9 MB of noise: two 8 MB chunks.
  const width = 1800;
  const height = 1700;
  const noise = Buffer.alloc(width * height * 3);
  for (let i = 0; i < noise.length; i++) noise[i] = (i * 7919) % 251;
  const file = join(dir, "big.png");
  await writeFile(
    file,
    await sharp(noise, { raw: { width, height, channels: 3 } })
      .png({ compressionLevel: 0 })
      .toBuffer(),
  );

  const outline = await api<{ id: string }>("POST", "/v1/outlines", {
    source: {
      type: "manual",
      nodes: [{ name: "L", printed_pages: { from: 1, to: 1 } }],
    },
  });
  await api("POST", `/v1/outlines/${outline.id}/confirm`);
  await page.goto(`/o/${orgId}/upload/${outline.id}?type=questions`);

  const ranges: string[] = [];
  let hold = true;
  await page.route("**/local-storage/uploads**", async (route) => {
    const range = route.request().headers()["content-range"] ?? "";
    ranges.push(range);
    // Let the first chunk through, then hang the second until the reload.
    if (hold && range.startsWith("bytes 8388608-")) return;
    await route.continue();
  });

  await page.getByLabel("صور الصفحات").check();
  await page.locator('input[type="file"]').setInputFiles(file);
  await page.getByRole("button", { name: "رفع", exact: true }).click();
  await page.waitForFunction(() =>
    (
      globalThis as unknown as { document: { body: { textContent: string } } }
    ).document.body.textContent.includes("%"),
  );
  while (!ranges.some((r) => r.startsWith("bytes 8388608-"))) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  hold = false;
  ranges.length = 0;
  await page.reload();
  await page.getByLabel("صور الصفحات").check();
  await page.locator('input[type="file"]').setInputFiles(file);
  await page.getByRole("button", { name: "رفع", exact: true }).click();
  await page.getByTestId("estimate").waitFor();

  const data = ranges.filter((r) => !r.startsWith("bytes */"));
  assert.ok(ranges[0]?.startsWith("bytes */"), "asks what arrived first");
  assert.ok(
    data.every((r) => !r.startsWith("bytes 0-")),
    `the first chunk isn't sent again: ${data.join(", ")}`,
  );
  assert.ok(data[0]?.startsWith("bytes 8388608-"));
  await page.unroute("**/local-storage/uploads**");
});
