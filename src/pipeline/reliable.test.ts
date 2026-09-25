// E-13: per-key caps, page retries, idempotency and signed webhooks.
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { after, before, describe, test } from "node:test";
import { startHarness, type Harness } from "../../test/harness.ts";
import { mcq, page } from "../../test/model.ts";
import { makePdf } from "../../test/pdf.ts";
import type { Document } from "../contract/document.ts";
import type { ModelPage } from "../reading/blocks.ts";
import { scriptedReader } from "../reading/scripted.ts";
import { verifyWebhook } from "../webhooks/signature.ts";
import { sweep } from "./sweep.ts";

const PAGES = 5;
const pages: Record<number, ModelPage> = {};
for (let p = 1; p <= PAGES; p++)
  pages[p] = page(String(p), [mcq(String(p), `q${String(p)}`)]);
let failing: Record<number, number> = {};
const reader = () => scriptedReader({ pages, failures: failing });

let h: Harness;
before(async () => {
  h = await startHarness({ reader, pipeline: { webhookRetryDelay: 1 } });
});
after(() => h.close());

const nodes = [{ name: "all", printed_pages: { from: 1, to: PAGES } }];
const DONE = ["completed", "completed_with_errors", "failed"];

/** Uploads a book, confirms an outline and returns what a document request needs. */
async function prepare(
  key = h.key,
  bytes = makePdf(Array.from({ length: PAGES }, (_, i) => `p${String(i + 1)}`)),
) {
  const created = await h.call(
    "POST",
    "/v1/uploads",
    {
      filename: "book.pdf",
      content_type: "application/pdf",
      size: bytes.length,
    },
    key,
  );
  const upload = (await created.json()) as { id: string; upload_url: string };
  await h.app.request(upload.upload_url.replace("http://engines.test", ""), {
    method: "PUT",
    body: bytes,
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
    outline_id: outline.id,
    type: "questions",
    source: { upload_id: upload.id },
    offset: "auto",
  };
}

async function times(id: string) {
  const { rows } = await h.db.query<{ started_at: Date; finished_at: Date }>(
    "SELECT started_at, finished_at FROM documents WHERE id = $1",
    [id],
  );
  const row = rows[0];
  if (!row) throw new Error(`no document ${id}`);
  return row;
}

describe("per-key concurrency", () => {
  test("a cap-1 key runs its documents one after the other while another key runs alongside", async () => {
    await h.db.query("UPDATE api_keys SET concurrency = 1 WHERE id = $1", [
      h.apiKeyId,
    ]);
    const other = await h.newKey("Other school");
    const requests = [
      await prepare(),
      await prepare(),
      await prepare(other.key),
    ];

    const a1 = (await (
      await h.call("POST", "/v1/documents", requests[0])
    ).json()) as { id: string; status: string };
    const a2 = (await (
      await h.call("POST", "/v1/documents", requests[1])
    ).json()) as { id: string; status: string };
    const b1 = (await (
      await h.call("POST", "/v1/documents", requests[2], other.key)
    ).json()) as {
      id: string;
      status: string;
    };
    assert.equal(a1.status, "rendering");
    assert.equal(a2.status, "queued", "the key's one slot is taken");
    assert.equal(b1.status, "rendering", "another key has its own slots");

    await h.waitFor(a1.id, DONE);
    await h.waitFor(a2.id, DONE);
    await h.waitFor(b1.id, DONE, 30_000, other.key);
    const [t1, t2, tb] = await Promise.all([
      times(a1.id),
      times(a2.id),
      times(b1.id),
    ]);
    assert.ok(
      t2.started_at >= t1.finished_at,
      "the second document started after the first ended",
    );
    assert.ok(tb.started_at < t1.finished_at, "the other key ran alongside");
  });

  test("a full queue is 429 too_many_jobs with Retry-After", async () => {
    await h.db.query(
      "UPDATE api_keys SET concurrency = 1, max_queued = 1 WHERE id = $1",
      [h.apiKeyId],
    );
    const requests = [await prepare(), await prepare(), await prepare()];
    const statuses = [];
    for (const request of requests)
      statuses.push(await h.call("POST", "/v1/documents", request));
    assert.deepEqual(
      statuses.map((r) => r.status),
      [202, 202, 429],
    );
    assert.equal(statuses[2]?.headers.get("retry-after"), "60");
    await h.db.query(
      "UPDATE api_keys SET concurrency = 2, max_queued = 20 WHERE id = $1",
      [h.apiKeyId],
    );
  });
});

test("a page that fails 3 times ends as part_failed, and the document still completes", async () => {
  failing = { 3: Number.POSITIVE_INFINITY };
  try {
    const created = (await (
      await h.call("POST", "/v1/documents", await prepare())
    ).json()) as { id: string };
    const doc = (await h.waitFor(created.id, DONE)) as unknown as Document;
    assert.equal(doc.status, "completed_with_errors");
    assert.deepEqual(
      doc.failures.map((f) => [f.reason, f.locator.pdf_page]),
      [["part_failed", 3]],
    );
    const { rows } = await h.db.query<{ attempts: number }>(
      "SELECT attempts FROM pages WHERE document_id = $1 AND pdf_page = 3",
      [created.id],
    );
    assert.equal(rows[0]?.attempts, 3);
    assert.equal(doc.questions.length, PAGES - 1);
  } finally {
    failing = {};
  }
});

describe("idempotency", () => {
  test("the same Idempotency-Key returns the same document, and no second job starts", async () => {
    const request = await prepare();
    const send = (body: unknown) =>
      h.app.request("/v1/documents", {
        method: "POST",
        headers: {
          authorization: `Bearer ${h.key}`,
          "content-type": "application/json",
          "idempotency-key": "k-1",
        },
        body: JSON.stringify(body),
      });
    const first = (await (await send(request)).json()) as { id: string };
    const second = await send(request);
    assert.equal(second.status, 202);
    assert.equal(((await second.json()) as { id: string }).id, first.id);
    const { rows } = await h.db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM documents WHERE outline_id = $1",
      [request.outline_id],
    );
    assert.equal(rows[0]?.n, 1);

    const different = await send({ ...request, type: "both" });
    assert.equal(different.status, 422);
  });

  test("the same file again is a new job, with a warning", async () => {
    const bytes = makePdf(["same", "file", "each", "time", "!"]);
    const first = (await (
      await h.call("POST", "/v1/documents", await prepare(h.key, bytes))
    ).json()) as {
      warning: unknown;
    };
    assert.equal(first.warning, null);
    const again = (await (
      await h.call("POST", "/v1/documents", await prepare(h.key, bytes))
    ).json()) as {
      id: string;
      warning: { code: string } | null;
    };
    assert.equal(again.warning?.code, "same_file_processed");
    const doc = (await (
      await h.call("GET", `/v1/documents/${again.id}`)
    ).json()) as Document;
    assert.equal(doc.warning?.code, "same_file_processed");
  });
});

describe("webhooks", () => {
  let server: Server;
  const received: {
    status: number;
    body: string;
    signature: string | undefined;
  }[] = [];
  before(async () => {
    server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk: Buffer) => (body += chunk.toString()));
      request.on("end", () => {
        // The first delivery fails, to show it's retried.
        const status = received.length === 0 ? 500 : 200;
        received.push({
          status,
          body,
          signature: request.headers["engines-signature"] as string | undefined,
        });
        response.writeHead(status).end();
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
  });
  after(
    () =>
      new Promise<void>((resolve) =>
        server.close(() => {
          resolve();
        }),
      ),
  );

  test("a finished job is POSTed, signed, and retried after a failure", async () => {
    const { port } = server.address() as AddressInfo;
    const request = {
      ...(await prepare()),
      webhook_url: `http://127.0.0.1:${String(port)}/hook`,
    };
    const created = (await (
      await h.call("POST", "/v1/documents", request)
    ).json()) as { id: string };
    const doc = (await h.waitFor(created.id, DONE)) as unknown as Document;

    const deadline = Date.now() + 20_000;
    while (received.length < 2 && Date.now() < deadline) await sleep(100);
    assert.deepEqual(
      received.map((r) => r.status),
      [500, 200],
    );
    const delivered = received[1];
    assert.ok(delivered);
    assert.deepEqual(JSON.parse(delivered.body), {
      id: doc.id,
      object: "document",
      status: doc.status,
      revision: 1,
    });

    const { secret } = (await (
      await h.call("GET", "/v1/webhook_secret")
    ).json()) as { secret: string };
    assert.equal(
      verifyWebhook({
        secret,
        header: delivered.signature,
        body: delivered.body,
      }),
      true,
    );
    assert.equal(
      verifyWebhook({
        secret: "whsec_wrong",
        header: delivered.signature,
        body: delivered.body,
      }),
      false,
    );

    const log = await h.db.query<{ attempt: number; status_code: number }>(
      "SELECT attempt, status_code FROM webhook_deliveries WHERE document_id = $1 ORDER BY attempt",
      [doc.id],
    );
    assert.deepEqual(
      log.rows.map((r) => [r.attempt, r.status_code]),
      [
        [1, 500],
        [2, 200],
      ],
    );
  });
});

test("the sweep finishes a document whose counters say it's still waiting", async () => {
  const created = (await (
    await h.call("POST", "/v1/documents", await prepare())
  ).json()) as { id: string };
  await h.waitFor(created.id, DONE);
  // As if the last page's settle had been lost: every page is settled, but the
  // counter still waits for three and nothing will advance the document.
  await h.db.query(
    "UPDATE documents SET status = 'processing', stage = 'solve', pages_pending = 3, finished_at = NULL WHERE id = $1",
    [created.id],
  );
  const report = await sweep(h.worker.deps);
  assert.ok(report.advanced >= 1);
  const doc = (await h.waitFor(created.id, DONE)) as unknown as Document;
  assert.equal(doc.status, "completed");
});
