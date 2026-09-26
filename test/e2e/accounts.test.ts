// E-15 in the browser: sign up, make an organisation, make a key that works on
// /v1/, and the page reads right-to-left or left-to-right without spilling
// sideways at 400 px.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Page } from "playwright-core";
import { startPage, type PageHarness } from "../browser.ts";

let p: PageHarness;
let page: Page;
let shots = 0;
before(async () => {
  p = await startPage();
  page = await p.browser.newPage({ viewport: { width: 400, height: 800 } });
});
after(() => p.close());

/** Nothing on the page is wider than the window. */
async function fitsWidth(): Promise<void> {
  // SCREENSHOT_DIR=… keeps a picture of each screen checked, to look at by eye.
  const dir = process.env["SCREENSHOT_DIR"];
  if (dir) {
    const name = `${String(++shots).padStart(2, "0")}-${new URL(page.url()).pathname.replace(/\W+/g, "_")}.png`;
    await page.screenshot({ path: `${dir}/${name}`, fullPage: true });
  }
  // A string, so the root tsconfig (no DOM types) doesn't check browser code.
  const overflow = await page.evaluate<number>(
    "document.documentElement.scrollWidth - window.innerWidth",
  );
  assert.ok(
    overflow <= 0,
    `${page.url()} spills ${String(overflow)}px sideways`,
  );
}

test("sign up → organisation → key that works on /v1/, in Arabic and English", async () => {
  await page.goto(p.url);
  assert.equal(await page.getAttribute("html", "dir"), "rtl");
  assert.equal(await page.getAttribute("html", "lang"), "ar");
  await fitsWidth();

  await page.getByRole("button", { name: "إنشاء حساب" }).click();
  await page.getByLabel("الاسم").fill("أمل");
  await page.getByLabel("البريد الإلكتروني").fill("amal@example.com");
  await page.getByLabel("كلمة المرور").fill("a long enough password");
  await page
    .locator("form")
    .getByRole("button", { name: "إنشاء حساب" })
    .click();

  await page.waitForURL("**/organisations/new");
  await page.getByLabel("اسم المؤسسة").fill("مدرسة الأمل");
  await page.getByRole("button", { name: "إنشاء" }).click();
  await page.waitForURL(/\/o\/org_[^/]+\/keys$/);
  await fitsWidth();

  await page.getByLabel("اسم المفتاح").fill("Almahdi");
  await page.getByRole("button", { name: "إنشاء مفتاح" }).click();
  const key = (await page.getByTestId("new-key").textContent()) ?? "";
  assert.match(key, /^eng_/);
  await fitsWidth();

  const usage = await p.h.call("GET", "/v1/usage", undefined, key);
  assert.equal(usage.status, 200, "the key works on /v1/");

  await page.getByTestId("language").click();
  assert.equal(await page.getAttribute("html", "dir"), "ltr");
  assert.equal(await page.getAttribute("html", "lang"), "en");
  await page.getByRole("button", { name: "Done" }).click();
  await fitsWidth();

  for (const [tab, check] of [
    ["Members", "amal@example.com"],
    ["Usage and balance", "Balance"],
  ] as const) {
    await page.getByRole("link", { name: tab }).click();
    await page.getByText(check).first().waitFor();
    await fitsWidth();
  }

  // The choice sticks, and flips back.
  await page.reload();
  assert.equal(await page.getAttribute("html", "dir"), "ltr");
  await page.getByTestId("language").click();
  assert.equal(await page.getAttribute("html", "dir"), "rtl");
  await page.getByRole("link", { name: "مفاتيح API" }).click();
  await page.getByText("Almahdi").waitFor();
  await fitsWidth();
});

test("an invited member joins through the link", async () => {
  await page.getByRole("link", { name: "الأعضاء" }).click();
  await page.getByLabel("بريد العضو").fill("badr@example.com");
  await page.getByRole("button", { name: "دعوة" }).click();
  const link = (await page.locator("code.secret").textContent()) ?? "";
  assert.match(link, /\/invitations\/inv_/);

  const context = await p.browser.newContext({
    viewport: { width: 400, height: 800 },
  });
  const other = await context.newPage();
  await other.goto(link);
  await other.getByRole("button", { name: "إنشاء حساب" }).click();
  await other.getByLabel("الاسم").fill("بدر");
  await other.getByLabel("البريد الإلكتروني").fill("badr@example.com");
  await other.getByLabel("كلمة المرور").fill("another long password");
  await other
    .locator("form")
    .getByRole("button", { name: "إنشاء حساب" })
    .click();
  // Signing up from the link comes straight back to the invitation.
  await other.getByText("مدرسة الأمل").waitFor();
  await other.getByRole("button", { name: "قبول الدعوة" }).click();
  await other.waitForURL(/\/o\/org_[^/]+\/keys$/);
  await other.getByText("المالكون والمسؤولون فقط يديرون المفاتيح.").waitFor();
  await context.close();
});
