import assert from "node:assert/strict";
import { test } from "node:test";
import { mcq, mockModel, page } from "../../test/model.ts";
import { toBlock } from "./blocks.ts";
import { createModelReader } from "./model.ts";
import type { ModelCall } from "./reader.ts";

const image = {
  pdfPage: 7,
  bytes: new Uint8Array([1, 2, 3]),
  mediaType: "image/png" as const,
};
const context = { orgId: "org_1", documentId: "doc_1" };

function reader(replies: Parameters<typeof mockModel>[0]) {
  const calls: ModelCall[] = [];
  const model = mockModel(replies);
  return {
    calls,
    model,
    reader: createModelReader({
      main: { model, name: "test/model" },
      record: (call) => {
        calls.push(call);
        return Promise.resolve();
      },
      outputTokenSteps: [100, 200],
    }),
  };
}

test("a well-formed reply becomes normalised blocks", async () => {
  const { reader: r, calls } = reader([
    { text: JSON.stringify(page("٧", [mcq("1", "ما وحدة القوة؟")])) },
  ]);

  const reading = await r.readPage(image, context);

  assert.equal(reading.printed_number, 7);
  assert.equal(reading.blocks.length, 1);
  const [block] = reading.blocks;
  assert.ok(block);
  assert.equal(block.id, "p7#0");
  assert.equal(block.question?.options.length, 4);
  assert.equal(calls.length, 1);
  assert.deepEqual(
    calls.map((c) => [c.finishReason, c.purpose, c.ok]),
    [["stop", "read_page", true]],
  );
});

test("a reply that breaks the schema is rejected, not salvaged", async () => {
  const { reader: r, calls } = reader([
    { text: JSON.stringify({ printed_page: "7", blocks: [{ kind: "poem" }] }) },
  ]);

  await assert.rejects(r.readPage(image, context));
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.ok, false);
});

test("a length stop is retried with a higher output limit", async () => {
  const good = JSON.stringify(page("7", []));
  const {
    reader: r,
    calls,
    model,
  } = reader([
    { text: good.slice(0, 10), finishReason: "length" },
    { text: good },
  ]);

  const reading = await r.readPage(image, context);

  assert.equal(reading.printed_number, 7);
  assert.deepEqual(
    model.doGenerateCalls.map((c) => c.maxOutputTokens),
    [100, 200],
  );
  assert.deepEqual(
    calls.map((c) => c.finishReason),
    ["length", "stop"],
  );
});

test("still cut off at the highest limit fails the page", async () => {
  const { reader: r } = reader([{ text: "{", finishReason: "length" }]);
  await assert.rejects(r.readPage(image, context), /cut off/);
});

test("a pair re-read sends both images and returns the joined block on the first page", async () => {
  const joined = mcq("5", "السؤال كاملا");
  const { reader: r, model } = reader([
    {
      text: JSON.stringify({
        pages: [
          { page: 40, blocks: [joined] },
          { page: 41, blocks: [] },
        ],
      }),
    },
  ]);
  const halves = [
    toBlock(40, 3, { ...mcq("5", "السؤال"), continues: true }),
    toBlock(41, 0, { ...mcq("5", "كاملا"), continued_from: true }),
  ] as const;

  const block = await r.readPair(
    [
      { ...image, pdfPage: 40 },
      { ...image, pdfPage: 41 },
    ],
    halves,
    context,
  );

  assert.equal(block.id, "p40#3");
  assert.equal(block.text, "السؤال كاملا");
  const content = model.doGenerateCalls[0]?.prompt.at(-1)?.content;
  assert.ok(Array.isArray(content));
  assert.equal(content.filter((part) => part.type === "file").length, 2);
});
