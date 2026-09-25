import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { after, before, test } from "node:test";
import { startHarness, type Harness } from "../../test/harness.ts";
import { scriptedReader } from "../reading/scripted.ts";
import { queues } from "../shared/queues.ts";

let h: Harness;
before(async () => {
  h = await startHarness({ reader: () => scriptedReader({ pages: {} }) });
});
after(() => h.close());

test("the worker connects pg-boss and completes a no-op job", async () => {
  const id = await h.worker.boss.send(queues.noop, {});
  assert.ok(id, "pg-boss accepted the job");

  const deadline = Date.now() + 15_000;
  let state: string | undefined;
  while (Date.now() < deadline) {
    const [job] = await h.worker.boss.findJobs(queues.noop, { id });
    state = job?.state;
    if (state === "completed" || state === "failed") break;
    await sleep(100);
  }

  assert.equal(state, "completed");
});
