// A worker without model access (no key or model name) still renders books:
// only what needs the model fails, with why, and the credits come back.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { startHarness, type Harness } from "../../test/harness.ts";
import { makePdf } from "../../test/pdf.ts";
import { unavailableReader } from "../reading/reader.ts";

let h: Harness;
before(async () => {
  h = await startHarness({
    reader: () => unavailableReader(new Error("OPENROUTER_API_KEY is not set")),
    pipeline: { pageAttempts: 1 },
  });
});
after(() => h.close());

test("without model access a book renders, then its pages fail with why", async () => {
  const outline = (await (
    await h.call("POST", "/v1/outlines", {
      source: {
        type: "manual",
        nodes: [{ name: "L", printed_pages: { from: 1, to: 2 } }],
      },
    })
  ).json()) as { id: string };
  await h.call("POST", `/v1/outlines/${outline.id}/confirm`);
  const upload = await h.upload(makePdf(["one", "two"]), "application/pdf");
  const created = await h.call("POST", "/v1/documents", {
    outline_id: outline.id,
    type: "questions",
    source: { upload_id: upload },
  });
  assert.equal(created.status, 202, await created.clone().text());
  const { id } = (await created.json()) as { id: string };

  // The quick pass found no numbers; a person confirms the offset.
  await h.waitFor(id, ["awaiting_offset"]);
  await h.call("POST", `/v1/documents/${id}/offset`, {
    segments: [{ printed_from: 1, pdf_from: 1 }],
  });
  const done = (await h.waitFor(id, ["failed", "completed_with_errors"])) as {
    status: string;
    failures: { detail: string; locator: { pdf_page: number } }[];
    usage: { pages: number };
  };
  assert.equal(done.status, "completed_with_errors");
  assert.deepEqual(
    done.failures.map((f) => [f.locator.pdf_page, f.detail]),
    [
      [1, "OPENROUTER_API_KEY is not set"],
      [2, "OPENROUTER_API_KEY is not set"],
    ],
  );
  assert.equal(done.usage.pages, 0, "nothing billed for pages not read");
});
