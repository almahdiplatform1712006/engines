// E-05: a small PDF goes in, placed questions come out, API only, with a
// scripted model so CI needs no key. Real poppler, Postgres, pg-boss and storage.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { startHarness, type Harness } from "../../test/harness.ts";
import { mcq, modelBlock, page } from "../../test/model.ts";
import { makePdf } from "../../test/pdf.ts";
import type { Document } from "../contract/document.ts";
import { scriptedReader } from "../reading/scripted.ts";

const reader = scriptedReader({
  pages: {
    1: page("1", [mcq("1", "ما وحدة القوة؟")]),
    2: page("2", [modelBlock({ kind: "neither", text: "صورة" })]),
    3: page("3", [mcq("2", "ما وحدة الطاقة؟"), mcq("3", "ما وحدة الشغل؟")]),
    5: page("5", [mcq("4", "سؤال خارج كل الدروس")]),
  },
  failures: { 2: 1 },
});

let h: Harness;
before(async () => {
  h = await startHarness({ reader: () => reader });
});
after(() => h.close());

const tree = [
  {
    id: "l1",
    name: "الدرس الأول",
    printed_pages: { from: 1, to: 2 },
    external_ref: "lesson:1",
  },
  { id: "l2", name: "الدرس الثاني", printed_pages: { from: 3, to: 4 } },
];

async function json<T>(response: Response, status: number): Promise<T> {
  const body = (await response.json()) as T;
  assert.equal(response.status, status, JSON.stringify(body));
  return body;
}

describe("the tracer bullet", () => {
  test("upload → outline → confirm → document → poll returns placed questions", async () => {
    const uploadId = await h.upload(
      makePdf(["one", "two", "three", "four", "five"]),
      "application/pdf",
    );

    const outline = await json<{ id: string; status: string }>(
      await h.call("POST", "/v1/outlines", {
        source: { type: "manual", nodes: tree },
      }),
      201,
    );
    assert.equal(outline.status, "draft");
    const confirmed = await json<{ status: string }>(
      await h.call("POST", `/v1/outlines/${outline.id}/confirm`),
      200,
    );
    assert.equal(confirmed.status, "confirmed");

    const created = await json<{ id: string; object: string; status: string }>(
      await h.call("POST", "/v1/documents", {
        outline_id: outline.id,
        type: "questions",
        source: { upload_id: uploadId },
      }),
      202,
    );
    assert.equal(created.object, "document");

    // The quick pass read the printed numbers and proposes printed = PDF page.
    const awaiting = (await h.waitFor(created.id, [
      "awaiting_offset",
    ])) as unknown as Document;
    assert.deepEqual(
      awaiting.offset.map((s) => [s.printed_from, s.pdf_from, s.confirmed]),
      [[1, 1, false]],
    );
    assert.deepEqual(reader.reads, [], "the full read waits for the offset");
    await json(
      await h.call("POST", `/v1/documents/${created.id}/offset`, {}),
      200,
    );

    const doc = (await h.waitFor(created.id, [
      "completed",
      "completed_with_errors",
      "failed",
    ])) as unknown as Document;

    assert.equal(doc.status, "completed_with_errors");
    assert.equal(doc.usage.pages, 5);
    assert.deepEqual(
      doc.questions.map((q) => [
        q.number,
        q.node_id,
        q.locator.pdf_page,
        q.external_ref,
      ]),
      [
        ["1", "l1", 1, "lesson:1"],
        ["2", "l2", 3, null],
        ["3", "l2", 3, null],
      ],
    );
    assert.deepEqual(
      doc.failures.map((f) => [f.reason, f.locator.pdf_page]),
      [["unmapped_page", 5]],
    );
    assert.equal(doc.skipped.neither, 1);

    // Page 2 failed once and was retried on its own; no other page was read twice.
    const reads = reader.reads.filter((p) => p !== 2).sort();
    assert.deepEqual(reads, [1, 3, 4, 5]);
    assert.equal(reader.reads.filter((p) => p === 2).length, 2);

    // The book file is deleted when the job ends.
    assert.equal(await h.store.size(`uploads/${h.orgId}/${uploadId}`), null);
  });

  test("confirm is refused for a node without a range or a child outside its parent", async () => {
    const noRange = await json<{ id: string }>(
      await h.call("POST", "/v1/outlines", {
        source: { type: "manual", nodes: [{ name: "بدون صفحات" }] },
      }),
      201,
    );
    const refused = await json<{ error: { code: string } }>(
      await h.call("POST", `/v1/outlines/${noRange.id}/confirm`),
      422,
    );
    assert.equal(refused.error.code, "outline_invalid");

    const outside = await json<{ id: string }>(
      await h.call("POST", "/v1/outlines", {
        source: {
          type: "manual",
          nodes: [
            {
              name: "unit",
              printed_pages: { from: 1, to: 10 },
              children: [{ name: "l", printed_pages: { from: 9, to: 12 } }],
            },
          ],
        },
      }),
      201,
    );
    await json(await h.call("POST", `/v1/outlines/${outside.id}/confirm`), 422);
  });

  test("a document needs a confirmed outline", async () => {
    const uploadId = await h.upload(makePdf(["one"]), "application/pdf");
    const draft = await json<{ id: string }>(
      await h.call("POST", "/v1/outlines", {
        source: { type: "manual", nodes: tree },
      }),
      201,
    );
    const refused = await json<{ error: { code: string } }>(
      await h.call("POST", "/v1/documents", {
        outline_id: draft.id,
        type: "questions",
        source: { upload_id: uploadId },
      }),
      409,
    );
    assert.equal(refused.error.code, "outline_not_confirmed");
  });

  test("a confirmed outline is frozen", async () => {
    const outline = await json<{ id: string }>(
      await h.call("POST", "/v1/outlines", {
        source: { type: "manual", nodes: tree },
      }),
      201,
    );
    await json(await h.call("POST", `/v1/outlines/${outline.id}/confirm`), 200);
    const refused = await json<{ error: { code: string } }>(
      await h.call("PUT", `/v1/outlines/${outline.id}`, { nodes: tree }),
      409,
    );
    assert.equal(refused.error.code, "outline_frozen");
  });

  test("another organisation's outline and document are invisible", async () => {
    const other = await h.newKey("Someone else");
    const outline = await json<{ id: string }>(
      await h.call("POST", "/v1/outlines", {
        source: { type: "manual", nodes: tree },
      }),
      201,
    );
    const response = await h.call(
      "GET",
      `/v1/outlines/${outline.id}`,
      undefined,
      other.key,
    );
    assert.equal(response.status, 404);
  });
});
