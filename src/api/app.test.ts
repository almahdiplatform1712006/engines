import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { startHarness, type Harness } from "../../test/harness.ts";
import { scriptedReader } from "../reading/scripted.ts";

let h: Harness;
before(async () => {
  h = await startHarness({ reader: () => scriptedReader({ pages: {} }) });
});
after(() => h.close());

test("GET /v1/health reports the service is up, with no key", async () => {
  const response = await h.app.request("/v1/health");

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok" });
});

test("unknown routes are 404", async () => {
  const response = await h.call("GET", "/v1/nope");

  assert.equal(response.status, 404);
});

test("every other /v1/ route needs a valid key", async () => {
  const none = await h.app.request("/v1/outlines/out_x");
  assert.equal(none.status, 401);
  const wrong = await h.call(
    "GET",
    "/v1/outlines/out_x",
    undefined,
    "eng_not-a-real-key",
  );
  assert.equal(wrong.status, 401);
  assert.equal(
    ((await wrong.json()) as { error: { code: string } }).error.code,
    "unauthorized",
  );
});
