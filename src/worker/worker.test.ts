import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { after, before, test } from "node:test";
import { createTestDatabase, type TestDatabase } from "../../test/database.ts";
import { queues } from "../shared/queues.ts";
import { startWorker, type Worker } from "./worker.ts";

let db: TestDatabase;
let worker: Worker;
before(async () => {
  db = await createTestDatabase();
  worker = await startWorker({ databaseUrl: db.url });
});
after(async () => {
  await worker.stop();
  await db.drop();
});

test("the worker connects pg-boss and completes a no-op job", async () => {
  const id = await worker.boss.send(queues.noop, {});
  assert.ok(id, "pg-boss accepted the job");

  const deadline = Date.now() + 15_000;
  let state: string | undefined;
  while (Date.now() < deadline) {
    const [job] = await worker.boss.findJobs(queues.noop, { id });
    state = job?.state;
    if (state === "completed" || state === "failed") break;
    await sleep(100);
  }

  assert.equal(state, "completed");
});
