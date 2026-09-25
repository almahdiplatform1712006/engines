// E-16 in the browser: a syllabus PDF becomes a drafted tree; the editor shows
// the API's own errors, re-parents by drag-and-drop, and confirms.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Page } from "playwright-core";
import { grantCredits } from "../../src/accounts/credits.ts";
import { grantEntitlement } from "../../src/accounts/entitlements.ts";
import type { Outline } from "../../src/contract/outline.ts";
import type { ContentsEntry } from "../../src/outline/draft.ts";
import { scriptedReader } from "../../src/reading/scripted.ts";
import {
  assertFitsWidth,
  signedIn,
  startPage,
  type PageHarness,
} from "../browser.ts";
import { makePdf } from "../pdf.ts";

const entry = (name: string, depth: number, from: number): ContentsEntry => ({
  name,
  depth,
  level: depth === 1 ? "الوحدة" : "الدرس",
  from,
  to: null,
  answerKey: false,
});

let p: PageHarness;
let page: Page;
let orgId: string;
before(async () => {
  p = await startPage({
    reader: () =>
      scriptedReader({
        pages: {},
        contents: {
          1: [
            entry("الوحدة الأولى", 1, 1),
            entry("الدرس الأول", 2, 1),
            entry("الدرس الثاني", 2, 4),
          ],
          2: [entry("الوحدة الثانية", 1, 9)],
        },
      }),
  });
  ({ page, orgId } = await signedIn(p, "editor@example.com"));
  page.on("console", (m) => {
    if (m.type() === "error") console.log("browser:", m.text());
  });
  page.on("pageerror", (e) => {
    console.log("page error:", e.message);
  });
  await grantEntitlement(p.h.db, orgId, "explanation");
  // Drafting needs credits to cover the syllabus pages.
  await grantCredits(p.h.db, orgId, 100, "test");
});
after(() => p.close());

/** The outline as the API has it, once the editor has saved (or, frozen, now). */
async function saved(id: string, frozen = false): Promise<Outline> {
  if (!frozen)
    await page
      .getByTestId("save-state")
      .filter({ hasText: /محفوظ|Saved/ })
      .waitFor();
  const { rows } = await p.h.db.query<{ org_id: string }>(
    "SELECT org_id FROM outlines WHERE id = $1",
    [id],
  );
  assert.equal(rows[0]?.org_id, orgId);
  const response = await page.request.get(`/v1/outlines/${id}`, {
    headers: { "engines-organisation": orgId },
  });
  return (await response.json()) as Outline;
}

const names = (outline: Outline): unknown =>
  outline.nodes.map((n) => [n.name, n.children.map((c) => c.name)]);

test("syllabus PDF → drafted tree → fix an error → drag to re-parent → confirm", async () => {
  await page.goto(`/o/${orgId}/new`);
  await page.getByLabel("الأسئلة والشرح").check();
  await page.getByLabel("ملف PDF للمنهج").check();
  await page.locator('input[type="file"]').setInputFiles({
    name: "syllabus.pdf",
    mimeType: "application/pdf",
    buffer: makePdf(["contents 1", "contents 2"]),
  });
  await assertFitsWidth(page);
  await page.getByRole("button", { name: "ابدأ" }).click();
  await page.waitForURL(/\/outlines\/out_[^?]+\?type=both/);
  const id = /outlines\/(out_[^?]+)/.exec(page.url())?.[1] ?? "";

  const nameInputs = page.getByLabel("الاسم", { exact: true });
  await nameInputs.first().waitFor();
  assert.deepEqual(
    await Promise.all(
      (await nameInputs.all()).map((input) => input.inputValue()),
    ),
    ["الوحدة الأولى", "الدرس الأول", "الدرس الثاني", "الوحدة الثانية"],
  );
  await page.getByAltText("صفحة المنهج 1").waitFor();
  await assertFitsWidth(page);

  // The last unit's end isn't on the contents page: an error until it's filled.
  const confirm = page.getByRole("button", { name: "تأكيد الشجرة" });
  assert.equal(await confirm.isDisabled(), true);
  await page.getByText("«الوحدة الثانية» يحتاج نطاق صفحات مطبوعة.").waitFor();
  const lastTo = page.getByLabel("إلى (الوحدة الثانية)");
  // Arabic-Indic digits are taken as typed.
  await lastTo.fill("١٢");
  await page.getByLabel("من (الوحدة الثانية)").fill("٩");
  assert.equal(await confirm.isDisabled(), false);

  // A lesson outside its unit is an error the API would give too.
  await page.getByLabel("إلى (الدرس الثاني)").fill("20");
  await page.getByText("خارج نطاق صفحات العقدة الأم").waitFor();
  assert.equal(await confirm.isDisabled(), true);
  await page.getByLabel("إلى (الدرس الثاني)").fill("8");
  assert.equal(await confirm.isDisabled(), false);

  let outline = await saved(id);
  assert.deepEqual(outline.errors, []);
  assert.deepEqual(outline.nodes[1]?.printed_pages, { from: 9, to: 12 });

  // Drag the second unit into the first, onto its middle.
  const handles = page.getByRole("button", { name: "اسحب لنقل العقدة" });
  const firstUnit = page.locator(".tree-node").first();
  const box = await firstUnit.boundingBox();
  await handles.nth(3).dragTo(firstUnit, {
    targetPosition: { x: 200, y: (box?.height ?? 40) / 2 },
  });
  outline = await saved(id);
  assert.deepEqual(names(outline), [
    ["الوحدة الأولى", ["الدرس الأول", "الدرس الثاني", "الوحدة الثانية"]],
  ]);
  // Now pages 9–12 sit outside the first unit's 1–8: the editor says so.
  await page.getByText("خارج نطاق صفحات العقدة الأم").waitFor();
  await page.getByLabel("إلى (الوحدة الأولى)").fill("12");
  await page
    .getByText("خارج نطاق صفحات العقدة الأم")
    .waitFor({ state: "detached" });

  // English flips the editor left to right, still inside 400 px.
  await page.getByTestId("language").click();
  assert.equal(await page.getAttribute("html", "dir"), "ltr");
  await assertFitsWidth(page);

  await page.getByRole("button", { name: "Confirm tree" }).click();
  await page.getByText("Tree confirmed").waitFor();
  outline = await saved(id, true);
  assert.equal(outline.status, "confirmed");
  await page.getByTestId("language").click();
});

test("typing the tree in starts with one node", async () => {
  await page.goto(`/o/${orgId}/new`);
  await page.getByLabel("أكتبه بنفسي").check();
  await page.getByRole("button", { name: "ابدأ" }).click();
  await page.waitForURL(/\/outlines\/out_/);
  const name = page.getByLabel("الاسم", { exact: true });
  await name.first().waitFor();
  assert.equal(await name.count(), 1);
  await page.getByRole("button", { name: "+ مفتاح الإجابات" }).click();
  assert.equal(await name.count(), 2);
  await page.getByText("مفتاح الإجابات", { exact: true }).first().waitFor();
  await assertFitsWidth(page);
});

test("in English, a node moves below another (a leaf takes drops below it)", async () => {
  await page.getByTestId("language").click();
  await page.goto(`/o/${orgId}/new`);
  await page.getByLabel("I'll type it in").check();
  await page.getByRole("button", { name: "Start" }).click();
  await page.waitForURL(/\/outlines\/out_/);
  const id = /outlines\/(out_[^?]+)/.exec(page.url())?.[1] ?? "";
  const names = page.getByLabel("Name", { exact: true });
  await names.first().waitFor();
  await page.getByRole("button", { name: "+ Node" }).click();
  await names.nth(1).fill("Lesson 2");
  await names.first().fill("Lesson 1");

  const rows = page.locator(".tree-node");
  const box = await rows.nth(1).boundingBox();
  await page
    .getByRole("button", { name: "Drag to move the node" })
    .first()
    .dragTo(rows.nth(1), {
      targetPosition: { x: 40, y: (box?.height ?? 40) - 3 },
    });
  const outline = await saved(id);
  assert.deepEqual(
    outline.nodes.map((n) => [n.name, n.children.length]),
    [
      ["Lesson 2", 0],
      ["Lesson 1", 0],
    ],
  );
  await assertFitsWidth(page);
  await page.getByTestId("language").click();
});
