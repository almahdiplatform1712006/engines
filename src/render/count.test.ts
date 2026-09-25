import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { makePdf } from "../../test/pdf.ts";
import { localStore } from "../storage/local.ts";
import type { BlobStore } from "../storage/store.ts";
import { countPdfPages } from "./count.ts";

test("counts a stored PDF's pages from byte ranges", async () => {
  const dir = await mkdtemp(join(tmpdir(), "count-"));
  try {
    const base = localStore({
      dir,
      publicUrl: "http://x",
      secret: "0123456789abcdef",
    });
    let bytesRead = 0;
    const store: BlobStore = {
      ...base,
      readRange: async (key, start, end) => {
        const chunk = await base.readRange(key, start, end);
        bytesRead += chunk.length;
        return chunk;
      },
    };
    const pdf = makePdf(
      Array.from({ length: 12 }, (_, i) => `page ${String(i)}`),
    );
    await store.put("uploads/o/u", pdf, "application/pdf");
    assert.equal(await countPdfPages(store, "uploads/o/u", pdf.length), 12);
    assert.ok(bytesRead <= pdf.length);

    await store.put(
      "uploads/o/junk",
      Buffer.from("not a pdf at all"),
      "application/pdf",
    );
    assert.equal(await countPdfPages(store, "uploads/o/junk", 16), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
