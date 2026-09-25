// E-20: the back office is the owner's alone; granting credits unblocks a
// 402, the explanation switch changes what the API takes, cost per page
// shows for finished documents, and every change is audited.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { startHarness, type Harness } from "../../test/harness.ts";
import {
  newOrganisation,
  signUp,
  type Browser,
} from "../../test/page-client.ts";
import { makePdf } from "../../test/pdf.ts";
import { scriptedReader } from "../reading/scripted.ts";
import { mcq, page } from "../../test/model.ts";

let h: Harness;
let owner: Browser;
before(async () => {
  h = await startHarness({
    reader: () => scriptedReader({ pages: { 1: page("1", [mcq("1", "س")]) } }),
  });
  owner = await signUp(h, "owner@engines.example");
  await h.db.query("UPDATE users SET super_admin = true WHERE email = $1", [
    "owner@engines.example",
  ]);
});
after(() => h.close());

const ROUTES: [string, string, unknown?][] = [
  ["GET", "/page/admin/organisations"],
  ["GET", "/page/admin/organisations/org_x"],
  ["POST", "/page/admin/organisations/org_x/credits", { pages: 1, note: "x" }],
  [
    "PUT",
    "/page/admin/organisations/org_x/entitlements/explanation",
    { enabled: true },
  ],
  ["PATCH", "/page/admin/keys/key_x", { concurrency: 3 }],
  ["POST", "/page/admin/keys/key_x/revoke"],
  ["GET", "/page/admin/documents"],
  ["GET", "/page/admin/documents/doc_x"],
  ["GET", "/page/admin/audit"],
];

test("anyone but the super admin gets 403 on every back-office route", async () => {
  const someone = await signUp(h, "customer@example.com");
  await newOrganisation(someone, "Customer");
  for (const [method, path, body] of ROUTES) {
    const response = await someone.send(method, path, body);
    assert.equal(response.status, 403, `${method} ${path}`);
  }
  // Keys don't get in either: the back office is the page's.
  const withKey = await h.call("GET", "/page/admin/organisations");
  assert.equal(withKey.status, 401);
});

test("granting credits unblocks a 402; the explanation switch changes what the API takes", async () => {
  const customer = await h.newKey("Broke school", 0);
  const outline = (await (
    await h.call(
      "POST",
      "/v1/outlines",
      {
        source: {
          type: "manual",
          nodes: [{ name: "L", printed_pages: { from: 1, to: 1 } }],
        },
      },
      customer.key,
    )
  ).json()) as { id: string };
  await h.call(
    "POST",
    `/v1/outlines/${outline.id}/confirm`,
    undefined,
    customer.key,
  );
  const run = async (type: string) => {
    const pdf = makePdf(["one"]);
    const upload = (await (
      await h.call(
        "POST",
        "/v1/uploads",
        {
          filename: "b.pdf",
          content_type: "application/pdf",
          size: pdf.length,
        },
        customer.key,
      )
    ).json()) as { id: string; upload_url: string };
    const url = new URL(upload.upload_url);
    await h.app.request(url.pathname + url.search, {
      method: "PUT",
      body: pdf,
    });
    return h.call(
      "POST",
      "/v1/documents",
      { outline_id: outline.id, type, source: { upload_id: upload.id } },
      customer.key,
    );
  };
  assert.equal((await run("questions")).status, 402);

  const granted = await owner.json<{ balance: number }>(
    "POST",
    `/page/admin/organisations/${customer.orgId}/credits`,
    { pages: 50, note: "welcome" },
  );
  assert.equal(granted.balance, 50);
  assert.equal((await run("questions")).status, 202);

  assert.equal((await run("both")).status, 403);
  await owner.json(
    "PUT",
    `/page/admin/organisations/${customer.orgId}/entitlements/explanation`,
    { enabled: true },
  );
  assert.equal((await run("both")).status, 202);
  await owner.json(
    "PUT",
    `/page/admin/organisations/${customer.orgId}/entitlements/explanation`,
    { enabled: false },
  );
  assert.equal((await run("both")).status, 403);

  const detail = await owner.json<{
    balance: number;
    keys: { id: string }[];
    ledger: unknown[];
  }>("GET", `/page/admin/organisations/${customer.orgId}`);
  assert.ok(detail.keys.some((k) => k.id === customer.apiKeyId));
  assert.ok(detail.ledger.length > 0);

  // Key settings and revoking.
  await owner.json("PATCH", `/page/admin/keys/${customer.apiKeyId}`, {
    concurrency: 5,
    provider: "vertex",
  });
  const { rows } = await h.db.query<{ concurrency: number; provider: string }>(
    "SELECT concurrency, provider FROM api_keys WHERE id = $1",
    [customer.apiKeyId],
  );
  assert.deepEqual(rows[0], { concurrency: 5, provider: "vertex" });
  assert.equal(
    (await owner.send("POST", `/page/admin/keys/${customer.apiKeyId}/revoke`))
      .status,
    204,
  );
  assert.equal(
    (await h.call("GET", "/v1/usage", undefined, customer.key)).status,
    401,
  );

  const audit = await owner.json<{ data: { action: string; actor: string }[] }>(
    "GET",
    "/page/admin/audit",
  );
  assert.deepEqual(audit.data.map((a) => a.action).reverse(), [
    "credits.grant",
    "entitlement.grant",
    "entitlement.revoke",
    "key.update",
    "key.revoke",
  ]);
  assert.ok(audit.data.every((a) => a.actor === "owner@engines.example"));
});

test("jobs across organisations, with the model's cost per page", async () => {
  // Two pages, so cost per page isn't the total by accident.
  const doc = await h.runBook({
    pdf: makePdf(["one", "two"]),
    nodes: [{ name: "L", printed_pages: { from: 1, to: 2 } }],
  });
  await h.db.query(
    `INSERT INTO model_calls (org_id, document_id, purpose, model, ok, cost_usd)
     VALUES ($1, $2, 'read_page', 'test/model', true, 0.004), ($1, $2, 'solve', 'test/model', true, 0.002)`,
    [h.orgId, doc.id],
  );
  const jobs = await owner.json<{
    data: { id: string; cost_per_page: number | null; org_name: string }[];
  }>("GET", "/page/admin/documents?status=completed");
  const job = jobs.data.find((j) => j.id === doc.id);
  assert.ok(job);
  assert.ok(Math.abs((job.cost_per_page ?? 0) - 0.003) < 1e-9);
  const one = await owner.json<{ calls: { purpose: string }[] }>(
    "GET",
    `/page/admin/documents/${doc.id}`,
  );
  assert.deepEqual(one.calls.map((c) => c.purpose).sort(), [
    "read_page",
    "solve",
  ]);
});
