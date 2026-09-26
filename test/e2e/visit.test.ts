// E-21 in the browser: another platform's link opens Engines' page on one
// outline, with no tabs, no sign-in, and a way back.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { scriptedReader } from "../../src/reading/scripted.ts";
import { assertFitsWidth, startPage, type PageHarness } from "../browser.ts";

let p: PageHarness;
before(async () => {
  p = await startPage({ reader: () => scriptedReader({ pages: {} }) });
});
after(() => p.close());

test("a session link opens the outline, once, with a way back", async () => {
  const outline = (await (
    await p.h.call("POST", "/v1/outlines", {
      source: {
        type: "manual",
        nodes: [{ name: "درس من المهدي", external_ref: "almahdi:lesson:3" }],
      },
    })
  ).json()) as { id: string };
  const session = (await (
    await p.h.call("POST", "/v1/sessions", {
      outline_id: outline.id,
      return_url: "https://almahdi.example/course/3",
    })
  ).json()) as { url: string };

  const context = await p.browser.newContext({
    viewport: { width: 400, height: 900 },
  });
  const page = await context.newPage();
  await page.goto(session.url);
  await page.waitForURL(new RegExp(`/outlines/${outline.id}$`));
  assert.equal(
    await page.getByLabel("الاسم", { exact: true }).first().inputValue(),
    "درس من المهدي",
  );
  const back = page.getByTestId("back");
  assert.equal(
    await back.getAttribute("href"),
    "https://almahdi.example/course/3",
  );
  assert.match((await back.textContent()) ?? "", /almahdi\.example/);
  assert.equal(
    await page.locator("nav.tabs").count(),
    0,
    "no tabs for a visit",
  );
  assert.equal(
    await page.getByRole("button", { name: "تسجيل الخروج" }).count(),
    0,
  );
  await assertFitsWidth(page);

  // Used once: opening it again is refused.
  const again = await context.newPage();
  const response = await again.goto(session.url);
  assert.equal(response?.status(), 410);
  await context.close();
});
