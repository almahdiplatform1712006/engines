// The whole path through the real model adapter (Vercel AI SDK, Output.object,
// Zod) with a mock language model in place of the provider, so CI needs no key.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { startHarness, type Harness } from "../../test/harness.ts";
import { mcq, mockModel, page } from "../../test/model.ts";
import { makePdf } from "../../test/pdf.ts";
import type { Document } from "../contract/document.ts";
import { recordCallsIn } from "../reading/log.ts";
import { createModelReader } from "../reading/model.ts";

let h: Harness | undefined;
before(async () => {
  const model = mockModel([
    { text: JSON.stringify(page(null, [mcq("1", "ما وحدة القوة؟")])) },
  ]);
  h = await startHarness({
    reader: () =>
      createModelReader({
        main: { model, name: "mock/vision" },
        record: (call) => {
          if (!h) throw new Error("harness not started");
          return recordCallsIn(h.db)(call);
        },
      }),
  });
});
after(() => h?.close());

test("pages go through the model adapter, and every call is logged", async () => {
  if (!h) throw new Error("harness not started");
  const uploadId = await h.upload(
    makePdf(["one", "two", "three"]),
    "application/pdf",
  );
  const outline = (await (
    await h.call("POST", "/v1/outlines", {
      source: {
        type: "manual",
        nodes: [
          { id: "a", name: "A", printed_pages: { from: 1, to: 2 } },
          { id: "b", name: "B", printed_pages: { from: 3, to: 4 } },
        ],
      },
    })
  ).json()) as { id: string };
  await h.call("POST", `/v1/outlines/${outline.id}/confirm`);
  const created = (await (
    await h.call("POST", "/v1/documents", {
      outline_id: outline.id,
      type: "questions",
      source: { upload_id: uploadId },
    })
  ).json()) as { id: string };

  // The mock model reads no printed numbers, so the uploader states the offset.
  await h.waitFor(created.id, ["awaiting_offset"]);
  const confirmed = await h.call("POST", `/v1/documents/${created.id}/offset`, {
    segments: [{ printed_from: 1, pdf_from: 1 }],
  });
  assert.equal(confirmed.status, 200);

  const doc = (await h.waitFor(created.id, [
    "completed",
    "completed_with_errors",
    "failed",
  ])) as unknown as Document;

  assert.equal(doc.status, "completed");
  assert.deepEqual(
    doc.questions.map((q) => [q.node_id, q.locator.pdf_page]),
    [
      ["a", 1],
      ["a", 2],
      ["b", 3],
    ],
  );
  const calls = await h.db.query<{
    purpose: string;
    model: string;
    finish_reason: string;
    ok: boolean;
  }>(
    "SELECT purpose, model, finish_reason, ok FROM model_calls WHERE document_id = $1",
    [created.id],
  );
  const reads = calls.rows.filter((c) => c.purpose === "read_page");
  assert.equal(reads.length, 3);
  assert.equal(calls.rows.filter((c) => c.purpose === "read_number").length, 3);
  for (const call of reads) {
    assert.deepEqual(call, {
      purpose: "read_page",
      model: "mock/vision",
      finish_reason: "stop",
      ok: true,
    });
  }
});

test("the same upload can't run two documents", async () => {
  if (!h) throw new Error("harness not started");
  const uploadId = await h.upload(makePdf(["one"]), "application/pdf");
  const outline = (await (
    await h.call("POST", "/v1/outlines", {
      source: {
        type: "manual",
        nodes: [{ name: "A", printed_pages: { from: 1, to: 1 } }],
      },
    })
  ).json()) as { id: string };
  await h.call("POST", `/v1/outlines/${outline.id}/confirm`);
  const request = {
    outline_id: outline.id,
    type: "questions",
    source: { upload_id: uploadId },
  };
  assert.equal((await h.call("POST", "/v1/documents", request)).status, 202);
  const again = await h.call("POST", "/v1/documents", request);
  assert.equal(again.status, 409);
});
