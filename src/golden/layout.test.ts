import assert from "node:assert/strict";
import { test } from "node:test";
import { mcq, page } from "../../test/model.ts";
import { toPageReading } from "../reading/blocks.ts";
import { scriptedReader } from "../reading/scripted.ts";
import type { ModelCall } from "../reading/reader.ts";
import { azureLayout, toLayout as azureToLayout } from "./azure.ts";
import { boxFromPolygon, mergeLayout, withLayout } from "./layout.ts";
import { mistralOcr, toLayout as mistralToLayout } from "./mistral.ts";
import { METRIC_NAMES, type Run } from "./score.ts";
import { trialReport } from "./trial.ts";

const reading = toPageReading(
  3,
  page("iii", [mcq("1", "ما وحدة قياس القوة؟"), mcq("2", "سؤال آخر")]),
);

test("the add-on's page number and boxes replace the model's", () => {
  const merged = mergeLayout(reading, {
    pageNumber: "٧",
    regions: [
      {
        text: "٧",
        box: { x: 0.45, y: 0.95, w: 0.1, h: 0.03 },
        role: "pageNumber",
      },
      {
        text: "1. ما وحدة قياس القوة",
        box: { x: 0.1, y: 0.2, w: 0.8, h: 0.1 },
        role: null,
      },
    ],
    costUsd: 0.01,
  });
  assert.equal(merged.printed_number, 7);
  assert.deepEqual(merged.blocks[0]?.box, { x: 0.1, y: 0.2, w: 0.8, h: 0.1 });
  assert.equal(
    merged.blocks[1]?.box,
    reading.blocks[1]?.box ?? null,
    "no match: the model's box stays",
  );
});

test("polygons in page units become fractions of the page", () => {
  assert.deepEqual(boxFromPolygon([1, 2, 5, 2, 5, 4, 1, 4], 8.5, 11), {
    x: 1 / 8.5,
    y: 2 / 11,
    w: 4 / 8.5,
    h: 2 / 11,
  });
});

test("Azure Layout: analyze, poll, and read paragraphs with roles", async () => {
  const calls: string[] = [];
  const fake: typeof fetch = (input) => {
    const url = input as string;
    calls.push(url);
    if (url.includes(":analyze"))
      return Promise.resolve(
        new Response(null, {
          status: 202,
          headers: { "operation-location": "https://azure.example/op/1" },
        }),
      );
    return Promise.resolve(
      Response.json(
        calls.length < 3
          ? { status: "running" }
          : {
              status: "succeeded",
              analyzeResult: {
                pages: [{ pageNumber: 1, width: 10, height: 20 }],
                paragraphs: [
                  {
                    role: "pageNumber",
                    content: "12",
                    boundingRegions: [
                      { pageNumber: 1, polygon: [4, 18, 6, 18, 6, 19, 4, 19] },
                    ],
                  },
                  {
                    content: "Lesson 1",
                    role: "sectionHeading",
                    boundingRegions: [
                      { pageNumber: 1, polygon: [1, 1, 9, 1, 9, 2, 1, 2] },
                    ],
                  },
                ],
              },
            },
      ),
    );
  };
  const layout = await azureLayout({
    endpoint: "https://azure.example",
    key: "k",
    pricePerPage: 0.01,
    fetch: fake,
    pollMs: 1,
  }).analyze(new Uint8Array([1]));
  assert.equal(layout.pageNumber, "12");
  assert.deepEqual(layout.regions[1], {
    text: "Lesson 1",
    box: { x: 0.1, y: 0.05, w: 0.8, h: 0.05 },
    role: "sectionHeading",
  });
  assert.equal(layout.costUsd, 0.01);
  assert.match(calls[0] ?? "", /prebuilt-layout:analyze\?api-version=/);
  assert.equal(azureToLayout({}, 0).regions.length, 0);
});

test("Mistral OCR: blocks with boxes and a page-number block", async () => {
  let sent: unknown;
  const fake: typeof fetch = (_input, init) => {
    sent = JSON.parse(init?.body as string);
    return Promise.resolve(
      Response.json({
        pages: [
          {
            dimensions: { width: 100, height: 200 },
            blocks: [
              {
                type: "page_number",
                text: "٤",
                bbox: {
                  top_left_x: 45,
                  top_left_y: 190,
                  bottom_right_x: 55,
                  bottom_right_y: 198,
                },
              },
              {
                type: "text",
                text: "سؤال",
                bbox: {
                  top_left_x: 10,
                  top_left_y: 20,
                  bottom_right_x: 90,
                  bottom_right_y: 40,
                },
              },
            ],
          },
        ],
      }),
    );
  };
  const layout = await mistralOcr({
    key: "k",
    model: "ocr-model",
    pricePerPage: 0.002,
    fetch: fake,
  }).analyze(new Uint8Array([1]));
  assert.equal((sent as { model: string }).model, "ocr-model");
  assert.equal(layout.pageNumber, "٤");
  assert.deepEqual(layout.regions[1]?.box, { x: 0.1, y: 0.1, w: 0.8, h: 0.1 });
  assert.equal(mistralToLayout({}, 0).pageNumber, null);
});

test("withLayout logs the add-on's cost like a model call", async () => {
  const calls: ModelCall[] = [];
  const reader = withLayout(
    scriptedReader({ pages: { 1: page("1", [mcq("1", "q")]) } }),
    {
      name: "addon",
      analyze: () =>
        Promise.resolve({ pageNumber: "5", regions: [], costUsd: 0.003 }),
    },
    (call) => {
      calls.push(call);
      return Promise.resolve();
    },
  );
  const read = await reader.readPage(
    { pdfPage: 1, bytes: new Uint8Array(), mediaType: "image/png" },
    { orgId: "golden", documentId: null },
  );
  assert.equal(read.printed_number, 5);
  assert.deepEqual(
    calls.map((c) => [c.model, c.costUsd]),
    [["addon", 0.003]],
  );
});

test("the trial report puts page numbers, crops and cost first, for every set-up", () => {
  const run = (id: string, printed: number): Run => ({
    id,
    created_at: "2026-01-01T00:00:00Z",
    reader: id,
    totals: Object.fromEntries(
      METRIC_NAMES.map((m) => [
        m,
        m === "printed_page" ? { num: printed, den: 10 } : { num: 1, den: 2 },
      ]),
    ) as Run["totals"],
    pages: [],
    skipped: [],
    failures: [],
  });
  const report = trialReport(
    [
      {
        setup: { name: "Alone", reader: "model", model: "m" },
        run: run("a", 8),
      },
      {
        setup: { name: "With Azure", reader: "model+azure", model: "m" },
        run: run("b", 10),
      },
    ],
    "2026-01-01",
  );
  assert.match(report, /\| metric \| Alone \| With Azure \|/);
  assert.match(report, /\| printed-page accuracy \| 80\.0% \| 100\.0% \|/);
  assert.match(report, /waiting for the owner's decision/);
});
