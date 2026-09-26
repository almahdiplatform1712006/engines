// E-14: credits, limits and the 30-day expiry, on a fake clock.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { startHarness, type Harness } from "../../test/harness.ts";
import { mcq, page } from "../../test/model.ts";
import { makePdf } from "../../test/pdf.ts";
import { grantCredits } from "../accounts/credits.ts";
import type { Document } from "../contract/document.ts";
import { DAY_MS } from "../shared/clock.ts";
import { scriptedReader } from "../reading/scripted.ts";
import { sweep } from "./sweep.ts";

let now = new Date("2026-09-25T09:00:00Z");
const reader = scriptedReader({
  pages: Object.fromEntries(
    Array.from({ length: 5 }, (_, i) => [
      i + 1,
      page(String(i + 1), [mcq(String(i + 1), `q${String(i + 1)}`)]),
    ]),
  ),
  failures: { 5: Number.POSITIVE_INFINITY },
});

let h: Harness;
before(async () => {
  h = await startHarness({
    reader: () => reader,
    clock: () => now,
    pipeline: { pageAttempts: 1 },
  });
});
after(() => h.close());

const book = () => makePdf(["1", "2", "3", "4", "5"]);
const nodes = [{ name: "all", printed_pages: { from: 1, to: 5 } }];

async function request(key: string, pdf = book()) {
  const created = await h.call(
    "POST",
    "/v1/uploads",
    { filename: "book.pdf", content_type: "application/pdf", size: pdf.length },
    key,
  );
  const upload = (await created.json()) as { id: string; upload_url: string };
  await h.app.request(upload.upload_url.replace("http://engines.test", ""), {
    method: "PUT",
    body: pdf,
  });
  const outline = (await (
    await h.call(
      "POST",
      "/v1/outlines",
      { source: { type: "manual", nodes } },
      key,
    )
  ).json()) as {
    id: string;
  };
  await h.call("POST", `/v1/outlines/${outline.id}/confirm`, undefined, key);
  return {
    upload_id: upload.id,
    body: {
      outline_id: outline.id,
      type: "questions",
      source: { upload_id: upload.id },
    },
  };
}

async function ledgerOf(orgId: string) {
  const { rows } = await h.db.query<{
    kind: string;
    pages: number;
    document_id: string | null;
  }>(
    "SELECT kind, pages, document_id FROM credit_ledger WHERE org_id = $1 ORDER BY id",
    [orgId],
  );
  return rows;
}

describe("credits", () => {
  test("a document over the balance gets 402, and nothing is queued", async () => {
    const poor = await h.newKey("Poor school", 3);
    const { body } = await request(poor.key);
    const refused = await h.call("POST", "/v1/documents", body, poor.key);
    assert.equal(refused.status, 402);
    const error = (
      (await refused.json()) as { error: { code: string; message: string } }
    ).error;
    assert.equal(error.code, "insufficient_credits");
    assert.match(error.message, /5 pages/);
    assert.match(error.message, /balance is 3/);
    const { rows } = await h.db.query(
      "SELECT 1 FROM documents WHERE org_id = $1",
      [poor.orgId],
    );
    assert.equal(rows.length, 0);

    // Granting credits unblocks it.
    await grantCredits(h.db, poor.orgId, 10, "top-up");
    assert.equal(
      (await h.call("POST", "/v1/documents", body, poor.key)).status,
      202,
    );
  });

  test("a finished document writes exactly one usage entry, for the pages it read", async () => {
    const school = await h.newKey("Billing school", 20);
    const doc = await h.runBook({ pdf: book(), nodes, key: school.key });
    // Page 5 always fails, so four pages are billed.
    assert.equal(doc.usage.pages, 4);
    const entries = (await ledgerOf(school.orgId)).filter(
      (e) => e.document_id === doc.id,
    );
    assert.deepEqual(
      entries.map((e) => [e.kind, e.pages]),
      [
        ["hold", -5],
        ["release", 5],
        ["usage", -4],
      ],
    );
    const usage = (await (
      await h.call("GET", "/v1/usage", undefined, school.key)
    ).json()) as { balance: number };
    assert.equal(usage.balance, 16);
  });
});

test("over 800 pages is 413", async () => {
  const pdf = makePdf(Array.from({ length: 801 }, (_, i) => String(i)));
  const { body } = await request(h.key, pdf);
  const refused = await h.call("POST", "/v1/documents", body);
  assert.equal(refused.status, 413);
  assert.equal(
    ((await refused.json()) as { error: { code: string } }).error.code,
    "too_large",
  );
});

test("the book is deleted when its job ends; results are gone (410) after day 30", async () => {
  const { upload_id, body } = await request(h.key);
  const created = (await (
    await h.call("POST", "/v1/documents", body)
  ).json()) as { id: string };
  await h.waitFor(created.id, ["awaiting_offset"]);
  await h.call("POST", `/v1/documents/${created.id}/offset`, {});
  const doc = (await h.waitFor(created.id, [
    "completed",
    "completed_with_errors",
  ])) as unknown as Document;
  assert.equal(
    await h.store.size(`uploads/${h.orgId}/${upload_id}`),
    null,
    "the PDF is gone after the job",
  );
  assert.notEqual(
    await h.store.size(`pages/${doc.id}/1.png`),
    null,
    "page images stay for review",
  );

  now = new Date(now.getTime() + 29 * DAY_MS);
  await sweep(h.worker.deps);
  assert.equal(
    (await h.call("GET", `/v1/documents/${doc.id}`)).status,
    200,
    "still there on day 29",
  );

  now = new Date(now.getTime() + 2 * DAY_MS);
  await sweep(h.worker.deps);
  const gone = await h.call("GET", `/v1/documents/${doc.id}`);
  assert.equal(gone.status, 410);
  assert.equal(
    await h.store.size(`pages/${doc.id}/1.png`),
    null,
    "page images are gone",
  );
  const { rows } = await h.db.query(
    "SELECT 1 FROM revisions WHERE document_id = $1",
    [doc.id],
  );
  assert.equal(rows.length, 0);
});

test("a draft outline and an unused upload expire", async () => {
  const outline = (await (
    await h.call("POST", "/v1/outlines", { source: { type: "manual", nodes } })
  ).json()) as { id: string };
  const upload = (await (
    await h.call("POST", "/v1/uploads", {
      filename: "x.pdf",
      content_type: "application/pdf",
      size: 10,
    })
  ).json()) as { id: string };
  now = new Date(now.getTime() + 31 * DAY_MS);
  const report = await sweep(h.worker.deps);
  assert.ok(report.expired.outlines >= 1 && report.expired.uploads >= 1);
  assert.equal((await h.call("GET", `/v1/outlines/${outline.id}`)).status, 404);
  const { rows } = await h.db.query("SELECT 1 FROM uploads WHERE id = $1", [
    upload.id,
  ]);
  assert.equal(rows.length, 0);
});

test("a book can't start on a confirmed outline that has expired", async () => {
  const { body } = await request(h.key);
  now = new Date(now.getTime() + 31 * DAY_MS);
  const fresh = await request(h.key);
  const response = await h.call("POST", "/v1/documents", {
    ...body,
    source: fresh.body.source,
  });
  assert.equal(response.status, 404, await response.clone().text());
  // And the sweep still removes it.
  await sweep(h.worker.deps);
  assert.equal(
    (await h.call("GET", `/v1/outlines/${body.outline_id}`)).status,
    404,
  );
});
