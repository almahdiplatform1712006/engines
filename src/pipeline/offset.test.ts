// E-07: the quick pass proposes printed → PDF segments minutes after upload,
// the uploader confirms or corrects them, and the full read waits for that.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { startHarness, type Harness } from "../../test/harness.ts";
import { mcq, page } from "../../test/model.ts";
import { makePdf } from "../../test/pdf.ts";
import type { Document } from "../contract/document.ts";
import type { ModelPage } from "../reading/blocks.ts";
import { scriptedReader, type Script } from "../reading/scripted.ts";

// Each test sets the reader for the book it runs; tests run one at a time.
let current: ReturnType<typeof scriptedReader> = scriptedReader({ pages: {} });

let h: Harness;
before(async () => {
  h = await startHarness({ reader: () => current });
});
after(() => h.close());

/** A book with `frontMatter` unnumbered pages, then printed pages 1…`numbered`. */
function book(
  frontMatter: number,
  numbered: number,
  extra: Partial<Script> = {},
) {
  const pages: Record<number, ModelPage> = {};
  for (let printed = 1; printed <= numbered; printed++) {
    pages[frontMatter + printed] = page(String(printed), [
      mcq(String(printed), `question on printed ${String(printed)}`),
    ]);
  }
  return {
    pdf: makePdf(
      Array.from(
        { length: frontMatter + numbered },
        (_, i) => `page ${String(i + 1)}`,
      ),
    ),
    reader: scriptedReader({ pages, ...extra }),
  };
}

async function start(
  pdf: Buffer,
  nodes: unknown[],
  offset?: "auto" | "confirm",
): Promise<string> {
  const uploadId = await h.upload(pdf, "application/pdf");
  const outline = (await (
    await h.call("POST", "/v1/outlines", { source: { type: "manual", nodes } })
  ).json()) as {
    id: string;
  };
  await h.call("POST", `/v1/outlines/${outline.id}/confirm`);
  const created = await h.call("POST", "/v1/documents", {
    outline_id: outline.id,
    type: "questions",
    source: { upload_id: uploadId },
    ...(offset ? { offset } : {}),
  });
  assert.equal(created.status, 202);
  return ((await created.json()) as { id: string }).id;
}

const DONE = ["completed", "completed_with_errors", "failed"];

describe("the offset check", () => {
  test("the document stops at awaiting_offset, and the full read starts only once confirmed", async () => {
    const { pdf, reader } = book(4, 8);
    current = reader;
    const id = await start(pdf, [
      { id: "all", name: "all", printed_pages: { from: 1, to: 8 } },
    ]);

    const awaiting = (await h.waitFor(id, [
      "awaiting_offset",
    ])) as unknown as Document;
    assert.deepEqual(
      awaiting.offset.map((s) => [s.printed_from, s.pdf_from]),
      [[1, 5]],
      "front matter of four pages: printed 1 = PDF 5",
    );
    assert.equal(awaiting.offset_agreement, 1);
    assert.deepEqual(reader.reads, []);

    const confirmed = await h.call("POST", `/v1/documents/${id}/offset`, {});
    assert.equal(confirmed.status, 200);
    const doc = (await h.waitFor(id, DONE)) as unknown as Document;
    assert.equal(doc.status, "completed");
    assert.deepEqual(
      doc.questions.map((q) => [q.locator.pdf_page, q.locator.printed_page]),
      Array.from({ length: 8 }, (_, i) => [i + 5, i + 1]),
    );
    assert.ok(doc.offset.every((s) => s.confirmed));

    const again = await h.call("POST", `/v1/documents/${id}/offset`, {});
    assert.equal(again.status, 409, "the offset is confirmed once");
  });

  test('offset: "auto" pre-approves a well-agreeing fit', async () => {
    const { pdf, reader } = book(2, 10);
    current = reader;
    const id = await start(
      pdf,
      [{ name: "all", printed_pages: { from: 1, to: 10 } }],
      "auto",
    );
    const doc = (await h.waitFor(id, DONE)) as unknown as Document;
    assert.equal(doc.status, "completed");
    assert.equal(doc.questions.length, 10);
  });

  test("a correction changes where items are placed", async () => {
    // The quick pass misreads every number as one too high.
    const numbers: Record<number, string> = {};
    for (let pdfPage = 1; pdfPage <= 6; pdfPage++)
      numbers[pdfPage] = String(pdfPage + 1);
    const { pdf, reader } = book(0, 6, { numbers });
    current = reader;
    const id = await start(pdf, [
      { id: "l1", name: "l1", printed_pages: { from: 1, to: 3 } },
      { id: "l2", name: "l2", printed_pages: { from: 4, to: 6 } },
    ]);
    const awaiting = (await h.waitFor(id, [
      "awaiting_offset",
    ])) as unknown as Document;
    assert.deepEqual(
      awaiting.offset.map((s) => [s.printed_from, s.pdf_from]),
      [[2, 1]],
    );

    const bad = await h.call("POST", `/v1/documents/${id}/offset`, {
      segments: [
        { printed_from: 5, pdf_from: 1 },
        { printed_from: 1, pdf_from: 3 },
      ],
    });
    assert.equal(
      bad.status,
      400,
      "printed numbers that go backwards are refused",
    );

    await h.call("POST", `/v1/documents/${id}/offset`, {
      segments: [{ printed_from: 1, pdf_from: 1 }],
    });
    const doc = (await h.waitFor(id, DONE)) as unknown as Document;
    assert.deepEqual(
      doc.questions.map((q) => [q.locator.pdf_page, q.node_id]),
      [
        [1, "l1"],
        [2, "l1"],
        [3, "l1"],
        [4, "l2"],
        [5, "l2"],
        [6, "l2"],
      ],
    );
  });

  test("pages that contradict the confirmed offset become offset_break", async () => {
    const { pdf } = book(0, 6);
    // The full read finds printed 9 on PDF page 4, which the offset says is 4.
    current = scriptedReader({
      pages: { ...readerPages(6), 4: page("9", [mcq("4", "x")]) },
      numbers: { 4: "4" },
    });
    const id = await start(
      pdf,
      [{ name: "all", printed_pages: { from: 1, to: 6 } }],
      "auto",
    );
    const doc = (await h.waitFor(id, DONE)) as unknown as Document;
    assert.equal(doc.status, "completed_with_errors");
    assert.deepEqual(
      doc.failures.map((f) => [f.reason, f.locator.pdf_page]),
      [["offset_break", 4]],
    );
    assert.equal(doc.questions.length, 5);
  });

  test("the quick pass reads at most about 50 pages, whatever the book's length", async () => {
    const { pdf, reader } = book(0, 60);
    current = reader;
    const id = await start(pdf, [
      { name: "all", printed_pages: { from: 1, to: 60 } },
    ]);
    await h.waitFor(id, ["awaiting_offset"], 60_000);
    assert.ok(
      reader.numberReads.length <= 50,
      `read ${String(reader.numberReads.length)} numbers`,
    );
    assert.ok(reader.numberReads.length < 60);
  });
});

function readerPages(count: number): Record<number, ModelPage> {
  const pages: Record<number, ModelPage> = {};
  for (let p = 1; p <= count; p++)
    pages[p] = page(String(p), [mcq(String(p), `q${String(p)}`)]);
  return pages;
}
