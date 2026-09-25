// E-18: review's fixes become revision 2. The webhook fires with it, the API
// returns the fixed items, a recropped figure gets a new crop while revision
// 1 keeps the original, and an unplaced question can be placed.
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { startHarness, type Harness } from "../../test/harness.ts";
import { mcq, modelBlock, page } from "../../test/model.ts";
import { makePdf } from "../../test/pdf.ts";
import type { ResultBody } from "../assembly/result.ts";
import type { Document } from "../contract/document.ts";
import { scriptedReader } from "../reading/scripted.ts";

const reader = scriptedReader({
  pages: {
    1: page("1", [
      modelBlock({
        kind: "passage",
        stimulus_kind: "diagram",
        label: "شكل 1",
        text: "",
        box_2d: [100, 100, 400, 600],
      }),
      { ...mcq("1", "سؤال عن الشكل"), stimulus_label: "شكل 1" },
    ]),
    2: page("2", [mcq("2", "سؤال ثان")]),
    // Printed 9 where 3 is expected: an offset break, so its question isn't placed.
    3: page("9", [mcq("3", "سؤال خارج الشجرة")]),
  },
});

let h: Harness;
let server: Server;
const hooks: { revision: number }[] = [];
before(async () => {
  h = await startHarness({ reader: () => reader });
  server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString()));
    request.on("end", () => {
      hooks.push(JSON.parse(body) as { revision: number });
      response.writeHead(200).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
});
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await h.close();
});

test("fixes save as revision 2: webhook, fixed items, a new crop, the original kept", async () => {
  const doc = await h.runBook({
    pdf: makePdf(["one", "two", "three"]),
    nodes: [{ id: "l1", name: "الدرس", printed_pages: { from: 1, to: 2 } }],
  });
  assert.equal(doc.revision, 1);
  const { port } = server.address() as AddressInfo;
  await h.db.query("UPDATE documents SET webhook_url = $2 WHERE id = $1", [
    doc.id,
    `http://127.0.0.1:${String(port)}/hook`,
  ]);

  const figured = doc.questions.find((q) => q.stimulus_id !== null);
  const plain = doc.questions.find((q) => q.stimulus_id === null);
  const [stim] = doc.stimuli;
  assert.ok(figured && plain && stim?.image);
  // Page 3 reads as printed 9 where the offset expects 3: held, not placed.
  const unmapped = doc.failures.findIndex((f) => f.locator.pdf_page === 3);
  assert.ok(unmapped >= 0);

  const saved = await h.call("POST", `/v1/documents/${doc.id}/revisions`, {
    base_revision: 1,
    changes: [
      { op: "edit_question", id: plain.id, text: "سؤال مصحح", correct: ["ب"] },
      { op: "set_stimulus", id: figured.id, stimulus_id: null },
      { op: "recrop", id: stim.id, box: { x: 0.05, y: 0.05, w: 0.5, h: 0.4 } },
      { op: "place_block", pdf_page: 3, block_id: "p3#0", node_id: "l1" },
      { op: "dismiss_failure", index: unmapped },
    ],
  });
  assert.equal(saved.status, 201, await saved.clone().text());
  const fixed = (await saved.json()) as Document;
  assert.equal(fixed.revision, 2);
  const byId = new Map(fixed.questions.map((q) => [q.id, q]));
  assert.equal(byId.get(plain.id)?.text, "سؤال مصحح");
  assert.deepEqual(byId.get(plain.id)?.correct, ["ب"]);
  assert.equal(byId.get(figured.id)?.stimulus_id, null);
  const placed = fixed.questions.find((q) => q.text === "سؤال خارج الشجرة");
  assert.equal(placed?.node_id, "l1");
  assert.equal(
    fixed.failures.some((f) => f.locator.pdf_page === 3),
    false,
  );

  // The GET reads the latest revision.
  const got = (await (
    await h.call("GET", `/v1/documents/${doc.id}`)
  ).json()) as Document;
  assert.equal(got.revision, 2);
  assert.equal(got.questions.length, fixed.questions.length);

  // A new crop for revision 2; revision 1 still has the original.
  const { rows } = await h.db.query<{ number: number; result: ResultBody }>(
    "SELECT number, result FROM revisions WHERE document_id = $1 ORDER BY number",
    [doc.id],
  );
  const [r1, r2] = rows.map((r) => r.result.stimuli[0]?.image?.key);
  assert.ok(r1 && r2 && r1 !== r2, `${String(r1)} → ${String(r2)}`);
  assert.match(r2, /-r2\.png$/);
  assert.notEqual(await h.store.size(r1), null, "the original crop is kept");
  assert.notEqual(await h.store.size(r2), null);
  assert.notEqual(got.stimuli[0]?.image?.url, stim.image.url);

  const deadline = Date.now() + 15_000;
  while (!hooks.some((x) => x.revision === 2) && Date.now() < deadline)
    await sleep(100);
  assert.ok(
    hooks.some((x) => x.revision === 2),
    "the webhook fires with revision 2",
  );

  // Exports follow the latest revision.
  const exported = await h.call(
    "GET",
    `/v1/documents/${doc.id}/export?format=json`,
  );
  assert.equal(((await exported.json()) as Document).revision, 2);
});

test("a bad change saves nothing; a running document can't be revised", async () => {
  const doc = await h.runBook({
    pdf: makePdf(["one"]),
    nodes: [{ id: "l1", name: "L", printed_pages: { from: 1, to: 1 } }],
  });
  const bad = await h.call("POST", `/v1/documents/${doc.id}/revisions`, {
    base_revision: 1,
    changes: [
      { op: "delete", id: doc.questions[0]?.id ?? "" },
      { op: "delete", id: "q_nothing" },
    ],
  });
  assert.equal(bad.status, 400);
  const { rows } = await h.db.query(
    "SELECT 1 FROM revisions WHERE document_id = $1",
    [doc.id],
  );
  assert.equal(rows.length, 1);

  await h.db.query("UPDATE documents SET status = 'processing' WHERE id = $1", [
    doc.id,
  ]);
  const running = await h.call("POST", `/v1/documents/${doc.id}/revisions`, {
    base_revision: 1,
    changes: [{ op: "dismiss_failure", index: 0 }],
  });
  assert.equal(running.status, 409);
});

test("a save made on an older revision is refused, so it can't overwrite newer fixes", async () => {
  const doc = await h.runBook({
    pdf: makePdf(["one"]),
    nodes: [{ id: "l1", name: "L", printed_pages: { from: 1, to: 1 } }],
  });
  const [q] = doc.questions;
  assert.ok(q);
  const save = (base: number, text: string) =>
    h.call("POST", `/v1/documents/${doc.id}/revisions`, {
      base_revision: base,
      changes: [{ op: "edit_question", id: q.id, text }],
    });
  assert.equal((await save(1, "first")).status, 201);
  const stale = await save(1, "stale tab");
  assert.equal(stale.status, 409);
  const now = (await (
    await h.call("GET", `/v1/documents/${doc.id}`)
  ).json()) as Document;
  assert.equal(now.questions[0]?.text, "first");
  assert.notEqual(
    now.questions[0].answer_source,
    "review",
    "a text edit keeps the source",
  );

  // A person's answer is theirs; an answer that isn't an option is refused.
  const answered = await h.call("POST", `/v1/documents/${doc.id}/revisions`, {
    base_revision: 2,
    changes: [{ op: "edit_question", id: q.id, correct: ["ب"] }],
  });
  assert.equal(
    ((await answered.json()) as Document).questions[0]?.answer_source,
    "review",
  );
  const wrong = await h.call("POST", `/v1/documents/${doc.id}/revisions`, {
    base_revision: 3,
    changes: [{ op: "edit_question", id: q.id, correct: ["ي"] }],
  });
  assert.equal(wrong.status, 400);
  const tiny = await h.call("POST", `/v1/documents/${doc.id}/revisions`, {
    base_revision: 3,
    changes: [
      { op: "recrop", id: q.id, box: { x: 0.1, y: 0.1, w: 0, h: 0.2 } },
    ],
  });
  assert.equal(tiny.status, 400);
});
