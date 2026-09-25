// The whole stack for integration tests: a fresh database, the local blob store,
// the worker running the pipeline on a scripted reader, and the API app.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { Hono } from "hono";
import { createApiKey, createOrganisation } from "../src/accounts/keys.ts";
import { createApp } from "../src/api/app.ts";
import type { PipelineOptions } from "../src/pipeline/pipeline.ts";
import type { PageReader } from "../src/reading/reader.ts";
import { systemClock, type Clock } from "../src/shared/clock.ts";
import { runMigrations } from "../src/shared/db/migrate.ts";
import { connect, type Db } from "../src/shared/db/pool.ts";
import { localStore, type LocalStore } from "../src/storage/local.ts";
import { startWorker, type Worker } from "../src/worker/worker.ts";
import { createTestDatabase, type TestDatabase } from "./database.ts";

const PUBLIC_URL = "http://engines.test";

export interface Harness {
  db: Db;
  app: Hono;
  store: LocalStore;
  worker: Worker;
  orgId: string;
  apiKeyId: string;
  key: string;
  /** Calls the API as the harness's organisation. */
  call(
    method: string,
    path: string,
    body?: unknown,
    key?: string,
  ): Promise<Response>;
  /** Uploads bytes through `POST /v1/uploads` and the resumable URL. */
  upload(
    bytes: Buffer,
    contentType: string,
    filename?: string,
  ): Promise<string>;
  /** Polls the document until its status is one of `statuses`. */
  waitFor(
    documentId: string,
    statuses: string[],
    timeoutMs?: number,
  ): Promise<Record<string, unknown>>;
  newKey(
    orgName?: string,
  ): Promise<{ orgId: string; apiKeyId: string; key: string }>;
  close(): Promise<void>;
}

export interface HarnessOptions {
  reader: (provider: string) => PageReader;
  clock?: Clock;
  pipeline?: Partial<PipelineOptions>;
}

export async function startHarness(options: HarnessOptions): Promise<Harness> {
  const database: TestDatabase = await createTestDatabase();
  await runMigrations(database.url);
  const dir = await mkdtemp(join(tmpdir(), "engines-harness-"));
  const clock = options.clock ?? systemClock;
  const store = localStore({
    dir,
    publicUrl: PUBLIC_URL,
    secret: "harness-secret-harness",
  });
  const worker = await startWorker({
    databaseUrl: database.url,
    store,
    clock,
    reader: options.reader,
    options: {
      retryDelay: 1,
      pollingIntervalSeconds: 0.5,
      ...options.pipeline,
    },
  });
  const db = connect(database.url);
  const app = createApp({ db, boss: worker.boss, store, clock });

  const newKey = async (orgName = "Test organisation") => {
    const orgId = await createOrganisation(db, orgName);
    const created = await createApiKey(db, orgId, "test");
    return { orgId, apiKeyId: created.id, key: created.key };
  };
  const me = await newKey();

  const call = (method: string, path: string, body?: unknown, key = me.key) =>
    Promise.resolve(
      app.request(path, {
        method,
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );

  return {
    db,
    app,
    store,
    worker,
    ...me,
    call,
    newKey,
    async upload(bytes, contentType, filename = "book.pdf") {
      const created = await call("POST", "/v1/uploads", {
        filename,
        content_type: contentType,
        size: bytes.length,
      });
      if (created.status !== 201)
        throw new Error(`upload refused: ${await created.text()}`);
      const { id, upload_url } = (await created.json()) as {
        id: string;
        upload_url: string;
      };
      const put = await app.request(upload_url.replace(PUBLIC_URL, ""), {
        method: "PUT",
        body: bytes,
      });
      if (put.status !== 200)
        throw new Error(`upload PUT failed: ${String(put.status)}`);
      return id;
    },
    async waitFor(documentId, statuses, timeoutMs = 30_000) {
      const deadline = Date.now() + timeoutMs;
      let last: Record<string, unknown> = {};
      while (Date.now() < deadline) {
        const response = await call("GET", `/v1/documents/${documentId}`);
        last = (await response.json()) as Record<string, unknown>;
        if (statuses.includes(String(last["status"]))) return last;
        await sleep(100);
      }
      throw new Error(
        `document ${documentId} stuck at ${String(last["status"])}, wanted ${statuses.join("|")}`,
      );
    },
    async close() {
      await worker.stop();
      await db.close();
      await database.drop();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
