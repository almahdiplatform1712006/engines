// E-12: explanation chunks, only for organisations entitled to them.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { startHarness, type Harness } from "../../test/harness.ts";
import { mcq, modelBlock, page } from "../../test/model.ts";
import { makePdf } from "../../test/pdf.ts";
import {
  grantEntitlement,
  revokeEntitlement,
} from "../accounts/entitlements.ts";
import { scriptedReader } from "../reading/scripted.ts";

const reader = scriptedReader({
  pages: {
    1: page("1", [
      modelBlock({ kind: "heading", text: "القانون الثاني لنيوتن" }),
      modelBlock({
        kind: "explanation",
        text: "القوة تساوي الكتلة في التسارع $F = ma$",
        math_direction: "ltr",
      }),
      mcq("1", "ما وحدة القوة؟"),
    ]),
  },
});

let h: Harness;
before(async () => {
  h = await startHarness({ reader: () => reader });
});
after(() => h.close());

const nodes = [
  {
    id: "l1",
    name: "قوانين نيوتن",
    printed_pages: { from: 1, to: 1 },
    external_ref: "lesson:9",
  },
];

test("a key without the entitlement gets 403 for explanation and both", async () => {
  const uploadId = await h.upload(makePdf(["1"]), "application/pdf");
  const outline = (await (
    await h.call("POST", "/v1/outlines", { source: { type: "manual", nodes } })
  ).json()) as { id: string };
  await h.call("POST", `/v1/outlines/${outline.id}/confirm`);
  for (const type of ["explanation", "both"]) {
    const response = await h.call("POST", "/v1/documents", {
      outline_id: outline.id,
      type,
      source: { upload_id: uploadId },
    });
    assert.equal(response.status, 403);
    assert.equal(
      ((await response.json()) as { error: { code: string } }).error.code,
      "not_entitled",
    );
  }
});

test("both returns questions and explanation side by side, kept apart", async () => {
  await grantEntitlement(h.db, h.orgId, "explanation");
  const doc = await h.runBook({ pdf: makePdf(["1"]), nodes, type: "both" });

  assert.equal(doc.questions.length, 1);
  assert.deepEqual(
    doc.explanation?.map((c) => [
      c.node_id,
      c.external_ref,
      c.heading,
      c.math_direction,
      c.pages,
    ]),
    [
      [
        "l1",
        "lesson:9",
        "القانون الثاني لنيوتن",
        "ltr",
        { pdf: [1], printed: [1] },
      ],
    ],
  );
  const [chunk] = doc.explanation ?? [];
  assert.ok(chunk?.markdown.includes("$F = ma$"));

  // The explanation field goes when the entitlement does.
  await revokeEntitlement(h.db, h.orgId, "explanation");
  const again = (await (
    await h.call("GET", `/v1/documents/${doc.id}`)
  ).json()) as { explanation?: unknown };
  assert.equal(again.explanation, undefined);
});
