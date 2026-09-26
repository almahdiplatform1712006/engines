// E-20 in the browser: the owner's back office grants credits, switches the
// explanation entitlement and shows jobs with their cost per page.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Page } from "playwright-core";
import { scriptedReader } from "../../src/reading/scripted.ts";
import {
  assertFitsWidth,
  signedIn,
  startPage,
  type PageHarness,
} from "../browser.ts";
import { mcq, page as printed } from "../model.ts";
import { makePdf } from "../pdf.ts";

let p: PageHarness;
let page: Page;
before(async () => {
  p = await startPage({
    reader: () =>
      scriptedReader({ pages: { 1: printed("1", [mcq("1", "س")]) } }),
  });
  ({ page } = await signedIn(p, "owner@engines.example"));
  await p.h.db.query("UPDATE users SET super_admin = true WHERE email = $1", [
    "owner@engines.example",
  ]);
});
after(() => p.close());

test("the owner grants credits, switches explanation on, and sees jobs' cost", async () => {
  const doc = await p.h.runBook({
    pdf: makePdf(["one", "two"]),
    nodes: [{ name: "L", printed_pages: { from: 1, to: 2 } }],
  });
  await p.h.db.query(
    "INSERT INTO model_calls (org_id, document_id, purpose, model, ok, cost_usd) VALUES ($1, $2, 'read_page', 'm', true, 0.0125)",
    [p.h.orgId, doc.id],
  );

  await page.goto("/");
  await page.getByRole("link", { name: "لوحة الإدارة" }).click();
  await page.getByLabel("بحث").fill("Test organisation");
  await page.getByRole("link", { name: "Test organisation" }).click();
  const before = (await page.getByTestId("admin-balance").textContent()) ?? "";
  await page.getByLabel("الصفحات").fill("250");
  await page.getByLabel("ملاحظة").fill("هدية");
  await page.getByRole("button", { name: "منح رصيد" }).click();
  await page
    .getByTestId("admin-balance")
    .filter({ hasNotText: before })
    .waitFor();
  await page.getByLabel("الشرح").check();
  await page.getByLabel("الشرح").isChecked();
  await assertFitsWidth(page);

  const { rows } = await p.h.db.query(
    "SELECT 1 FROM entitlements WHERE org_id = $1 AND name = 'explanation'",
    [p.h.orgId],
  );
  assert.equal(rows.length, 1);

  await page.getByRole("link", { name: "المهام" }).click();
  await page.getByTestId("job").first().waitFor();
  const costs = await page.getByTestId("cost").allTextContents();
  assert.ok(
    costs.some((c) => c.includes("0.0063")),
    costs.join(" | "),
  );
  await assertFitsWidth(page);

  await page.getByRole("link", { name: "سجل التغييرات" }).click();
  await page.getByTestId("audit-row").nth(1).waitFor();
  const actions = await page.getByTestId("audit-row").allTextContents();
  assert.ok(actions.some((a) => a.includes("credits.grant")));
  assert.ok(actions.some((a) => a.includes("entitlement.grant")));
});
