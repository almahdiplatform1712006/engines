// When the quick pass finds no printed numbers (a scan, or the model failed),
// the offset screen still has a segment to fill in, with the book's pages.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { Page } from "playwright-core";
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

const reader = scriptedReader({
  pages: { 2: printed(null, [mcq("1", "سؤال")]) },
});

let p: PageHarness;
let page: Page;
let orgId: string;
let dir: string;
before(async () => {
  p = await startPage({ reader: () => reader });
  ({ page, orgId } = await signedIn(p, "offset@example.com"));
  await grantCredits(p.h.db, orgId, 1000, "test");
  dir = await mkdtemp(join(tmpdir(), "e2e-offset-"));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
  await p.close();
});

test("no printed numbers found: the person enters the offset", async () => {
  const headers = { "engines-organisation": orgId, origin: p.url };
  const outline = (await (
    await page.request.post("/v1/outlines", {
      headers,
      data: {
        source: {
          type: "manual",
          nodes: [
            { id: "a", name: "الدرس", printed_pages: { from: 1, to: 1 } },
          ],
        },
      },
    })
  ).json()) as { id: string };
  await page.request.post(`/v1/outlines/${outline.id}/confirm`, { headers });
  await page.goto(`/o/${orgId}/upload/${outline.id}?type=questions`);
  const file = join(dir, "scan.pdf");
  await writeFile(file, makePdf(["cover", "p1"]));
  await page.locator('input[type="file"]').setInputFiles(file);
  await page.getByRole("button", { name: "رفع", exact: true }).click();
  await page.getByRole("button", { name: "ابدأ المعالجة" }).click();
  await page.waitForURL(/\/documents\/doc_/);
  const documentId = /documents\/(doc_[^/?]+)/.exec(page.url())?.[1] ?? "";

  await page.getByText("لم نجد أرقام صفحات مطبوعة").waitFor({
    timeout: 20_000,
  });
  const confirm = page.getByRole("button", { name: "تأكيد", exact: true });
  assert.equal(await confirm.isDisabled(), true, "nothing to confirm yet");
  await page.locator(".thumbs img").first().waitFor();
  await assertFitsWidth(page);

  const segment = page.getByTestId("segment").first();
  await segment.getByLabel("الصفحة المطبوعة").fill("1");
  await segment.getByLabel("صفحة الملف").fill("2");
  await confirm.click();
  await page.getByRole("link", { name: "عرض النتائج" }).waitFor({
    timeout: 30_000,
  });

  const doc = (await (
    await page.request.get(`/v1/documents/${documentId}`, { headers })
  ).json()) as Document;
  assert.deepEqual(
    doc.questions.map((q) => q.node_id),
    ["a"],
  );
});
