// E-21: the typed client runs the E-05 flow against the whole stack over
// HTTP, and its webhook check agrees with the server's signatures.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import {
  createClient,
  EnginesError,
  verifyWebhook,
  type EnginesClient,
} from "../../client/src/index.ts";
import { startHarness, type Harness } from "../../test/harness.ts";
import { mcq, page } from "../../test/model.ts";
import { makePdf } from "../../test/pdf.ts";
import { scriptedReader } from "../reading/scripted.ts";
import { signWebhook } from "../webhooks/signature.ts";
import { ROUTES } from "./openapi.ts";

let h: Harness;
let server: ReturnType<typeof serve>;
let engines: EnginesClient;
before(async () => {
  // The harness signs upload URLs for its PUBLIC_URL; send those to the server.
  h = await startHarness({
    reader: () =>
      scriptedReader({
        pages: { 1: page("1", [mcq("1", "ما وحدة القوة؟")]) },
      }),
  });
  server = serve({ fetch: h.app.fetch, port: 0, hostname: "127.0.0.1" });
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${String(port)}`;
  engines = createClient({
    baseUrl: base,
    apiKey: h.key,
    // The client only ever passes URL strings.
    fetch: (input, init) =>
      fetch((input as string).replace("http://engines.test", base), init),
  });
});
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await h.close();
});

test("the client runs a book end to end", async () => {
  const uploadId = await engines.uploads.upload(makePdf(["page one"]), {
    filename: "book.pdf",
    contentType: "application/pdf",
  });
  const outline = await engines.outlines.create(
    {
      source: {
        type: "manual",
        nodes: [
          {
            name: "الدرس الأول",
            external_ref: "almahdi:lesson:1",
            printed_pages: { from: 1, to: 1 },
          },
        ],
      },
    },
    { idempotencyKey: "outline-1" },
  );
  assert.equal(outline.status, "draft");
  await engines.outlines.confirm(outline.id);
  const created = await engines.documents.create({
    outline_id: outline.id,
    type: "questions",
    source: { upload_id: uploadId },
  });
  assert.equal(created.object, "document");

  let doc = await engines.documents.get(created.id);
  for (let i = 0; i < 200 && doc.status !== "awaiting_offset"; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    doc = await engines.documents.get(created.id);
  }
  await engines.documents.confirmOffset(created.id, {
    segments: [{ printed_from: 1, pdf_from: 1 }],
  });
  for (let i = 0; i < 300 && !doc.status.startsWith("completed"); i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    doc = await engines.documents.get(created.id);
  }
  assert.equal(doc.status, "completed");
  assert.deepEqual(
    doc.questions.map((q) => [q.text, q.external_ref]),
    [["ما وحدة القوة؟", "almahdi:lesson:1"]],
  );

  const xlsx = await engines.documents.export(created.id, "xlsx");
  assert.equal(xlsx[0], 0x50, "a zip (PK)");
  assert.ok((await engines.usage()).balance > 0);

  const session = await engines.sessions.create({
    outline_id: outline.id,
    return_url: "https://almahdi.example/course/1",
  });
  assert.match(session.url, /\/page\/enter\?token=/);
});

test("refusals come back as EnginesError with the API's code", async () => {
  await assert.rejects(engines.documents.get("doc_missing"), (error) => {
    assert.ok(error instanceof EnginesError);
    assert.equal(error.status, 404);
    assert.equal(error.code, "not_found");
    return true;
  });
});

test("verifyWebhook accepts the server's signature and refuses tampering", async () => {
  const { secret } = await engines.webhookSecret();
  const body = JSON.stringify({
    id: "doc_1",
    object: "document",
    status: "completed",
    revision: 2,
  });
  const now = new Date();
  const header = signWebhook(secret, body, Math.floor(now.getTime() / 1000));
  assert.equal(await verifyWebhook({ secret, header, body, now }), true);
  assert.equal(
    await verifyWebhook({ secret, header, body: body.replace("2", "3"), now }),
    false,
  );
  assert.equal(
    await verifyWebhook({
      secret,
      header,
      body,
      now: new Date(now.getTime() + 10 * 60 * 1000),
    }),
    false,
    "too old",
  );
  assert.equal(
    await verifyWebhook({ secret, header: "junk", body, now }),
    false,
  );
});

test("GET /v1/openapi.json serves the committed openapi.json, without a key", async () => {
  const served = await h.app.request("/v1/openapi.json");
  assert.equal(served.status, 200);
  const committed = JSON.parse(
    await readFile(new URL("../../openapi.json", import.meta.url), "utf8"),
  ) as unknown;
  assert.deepEqual(await served.json(), committed);
});

test("openapi.json describes every /v1/ route the app has, and no other", () => {
  const described = new Set(
    ROUTES.map(
      (r) => `${r.method.toUpperCase()} ${r.path.replace(/\{(\w+)\}/g, ":$1")}`,
    ),
  );
  const served = new Set(
    h.app.routes
      .filter(
        (r) =>
          r.path.startsWith("/v1/") &&
          r.method !== "ALL" &&
          !["/v1/health", "/v1/openapi.json"].includes(r.path),
      )
      .map((r) => `${r.method} ${r.path}`),
  );
  assert.deepEqual([...served].sort(), [...described].sort());
});
