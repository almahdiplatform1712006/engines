import assert from "node:assert/strict";
import { test } from "node:test";
import { signWebhook, verifyWebhook } from "./signature.ts";
import { checkWebhookUrl, isPrivateAddress } from "./target.ts";

const secret = "whsec_test";
const body = JSON.stringify({
  id: "doc_1",
  object: "document",
  status: "completed",
  revision: 1,
});
const now = new Date("2026-09-25T12:00:00Z");
const t = Math.floor(now.getTime() / 1000);

test("a signature verifies against the raw body and secret", () => {
  const header = signWebhook(secret, body, t);
  assert.equal(verifyWebhook({ secret, header, body, now }), true);
});

test("a changed body, wrong secret, stale timestamp or missing header fails", () => {
  const header = signWebhook(secret, body, t);
  assert.equal(
    verifyWebhook({ secret, header, body: body.replace("1}", "2}"), now }),
    false,
  );
  assert.equal(
    verifyWebhook({ secret: "whsec_other", header, body, now }),
    false,
  );
  assert.equal(
    verifyWebhook({
      secret,
      header,
      body,
      now: new Date(now.getTime() + 600_000),
    }),
    false,
  );
  assert.equal(verifyWebhook({ secret, header: undefined, body, now }), false);
});

test("webhook URLs: https only, never private or metadata addresses", () => {
  assert.throws(() =>
    checkWebhookUrl("http://example.com/hook", { allowPrivate: false }),
  );
  assert.equal(
    checkWebhookUrl("https://example.com/hook", { allowPrivate: false }).host,
    "example.com",
  );
  for (const address of [
    "127.0.0.1",
    "10.1.2.3",
    "169.254.169.254",
    "192.168.0.1",
    "172.20.0.1",
    "::1",
    "fd00::1",
    "::ffff:10.0.0.1",
  ]) {
    assert.equal(isPrivateAddress(address), true, address);
  }
  assert.equal(isPrivateAddress("8.8.8.8"), false);
  assert.equal(isPrivateAddress("2001:4860:4860::8888"), false);
  // Node writes [::ffff:169.254.169.254] as [::ffff:a9fe:a9fe]; refused either way.
  assert.throws(() =>
    checkWebhookUrl("https://[::ffff:169.254.169.254]/", {
      allowPrivate: false,
    }),
  );
});
