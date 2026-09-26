import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { callLimiter } from "./limit.ts";
import { scriptedReader } from "./scripted.ts";

test("never more than `limit` model calls in flight", async () => {
  const inner = scriptedReader({ pages: {} });
  let active = 0;
  let peak = 0;
  const slow = {
    ...inner,
    async readPage(...args: Parameters<typeof inner.readPage>) {
      active++;
      peak = Math.max(peak, active);
      await sleep(20);
      active--;
      return inner.readPage(...args);
    },
  };
  const limited = callLimiter(2)(slow);
  const context = { orgId: "o", documentId: "d" };
  await Promise.all(
    Array.from({ length: 6 }, (_, i) =>
      limited.readPage(
        { pdfPage: i + 1, bytes: new Uint8Array(), mediaType: "image/png" },
        context,
      ),
    ),
  );
  assert.equal(peak, 2);
});
