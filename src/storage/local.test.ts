import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { localStore, type LocalStore } from "./local.ts";

let dir: string;
let store: LocalStore;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "store-test-"));
  store = localStore({
    dir,
    publicUrl: "http://engines.test",
    secret: "s3cret",
  });
});
after(() => rm(dir, { recursive: true, force: true }));

const path = (url: string) =>
  url.replace("http://engines.test/local-storage", "");

test("put, get, size and delete", async () => {
  await store.put("pages/doc_1/1.png", Buffer.from("png"), "image/png");
  assert.equal((await store.get("pages/doc_1/1.png")).toString(), "png");
  assert.equal(await store.size("pages/doc_1/1.png"), 3);
  await store.deletePrefix("pages/doc_1/");
  assert.equal(await store.size("pages/doc_1/1.png"), null);
});

test("keys must stay inside an area", async () => {
  await assert.rejects(store.put("../escape", Buffer.from(""), "x"));
  await assert.rejects(store.put("uploads/../../escape", Buffer.from(""), "x"));
});

test("a signed URL serves the object, and a tampered one doesn't", async () => {
  await store.put("results/doc_1/crop.png", Buffer.from("crop"), "image/png");
  const url = path(await store.signedUrl("results/doc_1/crop.png", 60));
  const ok = await store.routes.request(url);
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), "crop");
  const bad = await store.routes.request(url.replace("crop.png", "other.png"));
  assert.equal(bad.status, 403);
});

test("a resumable upload continues from where it stopped", async () => {
  const bytes = Buffer.from("0123456789");
  const url = path(
    await store.createUpload(
      "uploads/org_1/up_1",
      "application/pdf",
      bytes.length,
    ),
  );

  const first = await store.routes.request(url, {
    method: "PUT",
    headers: { "content-range": "bytes 0-3/10" },
    body: bytes.subarray(0, 4),
  });
  assert.equal(first.status, 308);
  assert.equal(
    await store.size("uploads/org_1/up_1"),
    null,
    "not finished yet",
  );

  // The connection dropped: ask how much arrived.
  const status = await store.routes.request(url, {
    method: "PUT",
    headers: { "content-range": "bytes */10" },
  });
  assert.equal(status.status, 308);
  assert.equal(status.headers.get("range"), "bytes=0-3");

  const rest = await store.routes.request(url, {
    method: "PUT",
    headers: { "content-range": "bytes 4-9/10" },
    body: bytes.subarray(4),
  });
  assert.equal(rest.status, 200);
  assert.equal(
    (await store.get("uploads/org_1/up_1")).toString(),
    "0123456789",
  );
});

test("a resumable upload larger than Cloud Run's 32 MB request cap, in chunks", async () => {
  const size = 33 * 1024 * 1024;
  const bytes = Buffer.alloc(size, 7);
  const url = path(
    await store.createUpload("uploads/org_1/big", "application/pdf", size),
  );
  const chunk = 8 * 1024 * 1024;
  for (let start = 0; start < size; start += chunk) {
    const end = Math.min(size, start + chunk);
    const response = await store.routes.request(url, {
      method: "PUT",
      headers: {
        "content-range": `bytes ${String(start)}-${String(end - 1)}/${String(size)}`,
      },
      body: bytes.subarray(start, end),
    });
    assert.equal(response.status, end === size ? 200 : 308);
  }
  assert.equal(await store.size("uploads/org_1/big"), size);
});
