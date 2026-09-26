// E-18 in the browser: each fix type saves as a new revision and survives a
// reload; a dragged crop gets a new image; unplaced questions get placed.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Page } from "playwright-core";
import type { Document } from "../../src/contract/document.ts";
import { scriptedReader } from "../../src/reading/scripted.ts";
import {
  assertFitsWidth,
  signedIn,
  startPage,
  type PageHarness,
} from "../browser.ts";
import { mcq, modelBlock, page as printed } from "../model.ts";
import { makePdf } from "../pdf.ts";

const reader = scriptedReader({
  pages: {
    1: printed("1", [
      modelBlock({
        kind: "passage",
        stimulus_kind: "diagram",
        label: "شكل 1",
        text: "",
        box_2d: [100, 100, 400, 600],
      }),
      { ...mcq("1", "سؤال عن الشكل $F = ma$"), stimulus_label: "شكل 1" },
      mcq("2", "سؤال بإجابة من النموذج"),
    ]),
    // Printed 9 where 2 is expected: held back, not placed.
    2: printed("9", [mcq("3", "سؤال لم يوضع")]),
  },
});

let p: PageHarness;
let page: Page;
let doc: Document;
before(async () => {
  p = await startPage({ reader: () => reader });
  let orgId: string;
  ({ page, orgId } = await signedIn(p, "reviewer@example.com"));
  // The book belongs to the harness organisation; the reviewer joins it.
  const { rows } = await p.h.db.query<{ user_id: string }>(
    "SELECT user_id FROM members WHERE org_id = $1",
    [orgId],
  );
  await p.h.db.query(
    "INSERT INTO members (id, org_id, user_id, role, created_at) VALUES ('mem_review', $1, $2, 'owner', now())",
    [p.h.orgId, rows[0]?.user_id],
  );
  doc = await p.h.runBook({
    pdf: makePdf(["one", "two"]),
    nodes: [
      { id: "l1", name: "الدرس الأول", printed_pages: { from: 1, to: 2 } },
    ],
  });
});
after(() => p.close());

const revision = async () =>
  ((await page.getByTestId("revision").textContent()) ?? "").replace(/\D/g, "");

const current = async () => {
  const response = await page.request.get(`/v1/documents/${doc.id}`, {
    headers: { "engines-organisation": p.h.orgId },
  });
  return (await response.json()) as Document;
};

test("fixes save as revisions and survive a reload", async () => {
  await page.goto(`/o/${p.h.orgId}/review/${doc.id}`);
  await page.getByRole("button", { name: /الدرس الأول/ }).click();
  await page.getByTestId("question").first().waitFor();
  assert.equal(await revision(), "1");
  assert.ok(
    (await page.locator(".rich math").count()) > 0,
    "math is rendered as MathML",
  );
  await assertFitsWidth(page);

  // Accept the model's answer.
  const modelQuestion = page
    .getByTestId("question")
    .filter({ hasText: "سؤال بإجابة من النموذج" });
  await modelQuestion.getByRole("button", { name: "قبول الإجابة" }).click();
  await page.getByText("المراجعة رقم 2").waitFor();
  assert.equal(
    await modelQuestion.getByRole("button", { name: "قبول الإجابة" }).count(),
    0,
  );

  // Edit its text.
  await modelQuestion.getByRole("button", { name: "تعديل" }).click();
  await page.getByLabel("نص السؤال").fill("سؤال بعد التصحيح");
  await page.getByRole("button", { name: "حفظ", exact: true }).click();
  await page.getByText("المراجعة رقم 3").waitFor();

  // Drag a new crop for the figure.
  const before = (await current()).stimuli[0]?.image?.url;
  await page.getByRole("button", { name: "قصّ الصورة" }).first().click();
  const area = page.getByTestId("crop-area");
  await area.waitFor();
  await area.locator("img").evaluate(
    (img) =>
      new Promise((resolve) => {
        const image = img as unknown as {
          complete: boolean;
          onload: (() => void) | null;
        };
        if (image.complete) resolve(null);
        else
          image.onload = () => {
            resolve(null);
          };
      }),
  );
  await area.scrollIntoViewIfNeeded();
  const box = await area.boundingBox();
  assert.ok(box);
  await page.mouse.move(box.x + box.width * 0.1, box.y + box.height * 0.1);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.4, {
    steps: 5,
  });
  await page.mouse.up();
  await page.getByTestId("crop-box").waitFor();
  await page.getByRole("button", { name: "حفظ القصّ" }).click();
  await page.getByText("المراجعة رقم 4").waitFor();
  const after = await current();
  assert.ok(after.stimuli[0]?.image?.url);
  assert.notEqual(after.stimuli[0].image.url, before, "a new signed image");

  // Place the question that wasn't placed.
  await page.getByRole("button", { name: /غير موضوع في الشجرة/ }).click();
  const failure = page.getByTestId("failure").first();
  await failure.getByRole("button", { name: "أسئلة الصفحة" }).click();
  await failure.getByText("سؤال لم يوضع", { exact: true }).waitFor();
  await failure.getByLabel("ضعه تحت…").selectOption("l1");
  await page.getByText("المراجعة رقم 5").waitFor();
  await failure.getByRole("button", { name: "تم التعامل معه" }).click();
  await page.getByText("المراجعة رقم 6").waitFor();

  // Everything is still there after a reload, in English too.
  await page.getByTestId("language").click();
  await page.reload();
  await page.getByRole("button", { name: /الدرس الأول/ }).click();
  await page.getByText("Revision 6").waitFor();
  await page.getByText("سؤال بعد التصحيح", { exact: true }).waitFor();
  await page.getByText("سؤال لم يوضع", { exact: true }).waitFor();
  await assertFitsWidth(page);
  await page.getByTestId("language").click();

  const final = await current();
  assert.equal(final.revision, 6);
  assert.equal(final.failures.length, doc.failures.length - 1);
});
