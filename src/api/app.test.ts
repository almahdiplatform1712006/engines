import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp } from "./app.ts";

test("GET /v1/health reports the service is up", async () => {
  const response = await createApp().request("/v1/health");

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok" });
});

test("unknown routes are 404", async () => {
  const response = await createApp().request("/v1/nope");

  assert.equal(response.status, 404);
});
