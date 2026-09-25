// E-19: all four exports of a finished document, Arabic right-to-left and not
// reversed, math and figures present, cached per revision, gone at day 30.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, before, test } from "node:test";
import { startHarness, type Harness } from "../../test/harness.ts";
import { mcq, modelBlock, page } from "../../test/model.ts";
import { makePdf } from "../../test/pdf.ts";
import { zipNames, zipText } from "../../test/zip.ts";
import { grantEntitlement } from "../accounts/entitlements.ts";
import type { Document } from "../contract/document.ts";
import { scriptedReader } from "../reading/scripted.ts";

const run = promisify(execFile);
const QUESTION = "ما وحدة قياس القوة؟";

const reader = scriptedReader({
  pages: {
    1: page("1", [
      modelBlock({ kind: "heading", text: "القانون الثاني" }),
      modelBlock({
        kind: "explanation",
        text: "القوة تساوي الكتلة في التسارع $F = ma$",
      }),
      modelBlock({
        kind: "passage",
        stimulus_kind: "diagram",
        label: "شكل 1",
        text: "",
        box_2d: [100, 100, 400, 600],
      }),
      {
        ...mcq("1", QUESTION),
        stimulus_label: "شكل 1",
        options: [
          { key: "أ", text: "نيوتن" },
          { key: "ب", text: "$\\frac{kg}{s}$" },
        ],
      },
    ]),
  },
});

let h: Harness;
let doc: Document;
before(async () => {
  h = await startHarness({ reader: () => reader });
  await grantEntitlement(h.db, h.orgId, "explanation");
  doc = await h.runBook({
    pdf: makePdf(["page"]),
    nodes: [
      { id: "l1", name: "الدرس الأول", printed_pages: { from: 1, to: 1 } },
    ],
    type: "both",
  });
});
after(() => h.close());

async function download(format: string) {
  const response = await h.call(
    "GET",
    `/v1/documents/${doc.id}/export?format=${format}`,
  );
  assert.equal(
    response.status,
    200,
    `${format}: ${response.status === 200 ? "" : await response.text()}`,
  );
  return { response, bytes: new Uint8Array(await response.arrayBuffer()) };
}

test("json is exactly the GET result", async () => {
  const { response, bytes } = await download("json");
  assert.equal(response.headers.get("content-type"), "application/json");
  const exported = JSON.parse(Buffer.from(bytes).toString()) as Document;
  assert.deepEqual(
    exported.questions.map((q) => q.id),
    doc.questions.map((q) => q.id),
  );
  assert.equal(exported.revision, doc.revision);
});

test("xlsx: questions, tree and explanation sheets, right-to-left", async () => {
  const { bytes } = await download("xlsx");
  const sheet = zipText(bytes, "xl/worksheets/sheet1.xml");
  assert.match(sheet, /rightToLeft="1"/);
  const strings = zipText(bytes, "xl/sharedStrings.xml");
  assert.ok(strings.includes(QUESTION), "Arabic text in logical order");
  assert.ok(
    zipNames(bytes).includes("xl/worksheets/sheet3.xml"),
    "an Explanation sheet for an entitled organisation",
  );
});

test("docx: right-to-left, Word equations, the figure, the Arabic font embedded", async () => {
  const { bytes } = await download("docx");
  const xml = zipText(bytes, "word/document.xml");
  assert.match(xml, /<w:bidi\/>/);
  assert.match(xml, /<m:oMath>/);
  assert.match(xml, /<m:f>/, "the fraction is a Word fraction");
  assert.ok(xml.includes(QUESTION));
  const names = zipNames(bytes);
  assert.ok(
    names.some((n) => n.startsWith("word/media/")),
    "the figure",
  );
  assert.ok(
    names.some((n) => n.startsWith("word/fonts/")),
    "the embedded font",
  );
});

test("pdf: Arabic text reads in order, with math and the figure", async () => {
  const { bytes } = await download("pdf");
  const dir = await mkdtemp(join(tmpdir(), "export-pdf-"));
  try {
    const file = join(dir, "sheet.pdf");
    await writeFile(file, bytes);
    const { stdout: text } = await run("pdftotext", [file, "-"]);
    // Embedded Type 3 glyphs come back with stray spaces; the letters themselves must be in order.
    const letters = text.replace(/\s+/g, "");
    assert.ok(
      letters.includes(QUESTION.replace(/\s+/g, "")),
      "Arabic in logical order, not reversed",
    );
    assert.ok(letters.includes("𝐹"), "math is rendered");
    const { stdout: images } = await run("pdfimages", ["-list", file]);
    assert.ok(images.split("\n").length > 3, "the figure is in the PDF");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a new revision invalidates the cached exports; after expiry, export is 410", async () => {
  await download("docx");
  assert.notEqual(
    await h.store.size(`results/${doc.id}/exports/r1.docx`),
    null,
    "cached",
  );

  const { rows } = await h.db.query<{ result: Record<string, unknown> }>(
    "SELECT result FROM revisions WHERE document_id = $1 AND number = 1",
    [doc.id],
  );
  const result = rows[0]?.result as { questions: { text: string }[] };
  const [first] = result.questions;
  if (first) first.text = "سؤال بعد المراجعة";
  await h.db.query(
    "INSERT INTO revisions (document_id, org_id, number, result) VALUES ($1, $2, 2, $3)",
    [doc.id, h.orgId, JSON.stringify(result)],
  );
  await h.db.query("UPDATE documents SET revision = 2 WHERE id = $1", [doc.id]);

  const { bytes } = await download("docx");
  assert.ok(zipText(bytes, "word/document.xml").includes("سؤال بعد المراجعة"));
  assert.notEqual(
    await h.store.size(`results/${doc.id}/exports/r2.docx`),
    null,
  );

  await h.db.query("UPDATE documents SET expired_at = now() WHERE id = $1", [
    doc.id,
  ]);
  const gone = await h.call(
    "GET",
    `/v1/documents/${doc.id}/export?format=xlsx`,
  );
  assert.equal(gone.status, 410);
});
