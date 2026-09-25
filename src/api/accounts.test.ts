// E-15: people sign up on the page, make an organisation, make an API key, and
// that key works on /v1/. One organisation never sees another's data.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { getMigrations } from "better-auth/db/migration";
import { startHarness, type Harness } from "../../test/harness.ts";
import { makePdf } from "../../test/pdf.ts";
import { newOrganisation, ORIGIN, signUp } from "../../test/page-client.ts";
import { scriptedReader } from "../reading/scripted.ts";
import { authOptions } from "../accounts/auth.ts";

let h: Harness;
before(async () => {
  h = await startHarness({ reader: () => scriptedReader({ pages: {} }) });
});
after(() => h.close());

describe("sign-up to a working key", () => {
  test("sign up → organisation → API key → the key works on /v1/", async () => {
    const b = await signUp(h, "amal@example.com");
    const me0 = await b.json<{ organisations: unknown[]; active: unknown }>(
      "GET",
      "/page/me",
    );
    assert.deepEqual(me0.organisations, []);
    assert.equal(me0.active, null);

    const orgId = await newOrganisation(b, "Amal School");
    assert.match(orgId, /^org_/);
    const me = await b.json<{
      organisations: { id: string; role: string }[];
      active: { id: string; role: string };
    }>("GET", "/page/me");
    assert.deepEqual(me.active, { id: orgId, role: "owner" });

    const created = await b.json<{ id: string; key: string }>(
      "POST",
      "/page/keys",
      { name: "Almahdi" },
    );
    assert.match(created.key, /^eng_/);
    const keys = await b.json<{ data: { id: string; prefix: string }[] }>(
      "GET",
      "/page/keys",
    );
    assert.deepEqual(
      keys.data.map((k) => k.id),
      [created.id],
      "listed, and the page's own key isn't",
    );
    assert.ok(!JSON.stringify(keys).includes(created.key), "shown once");

    const usage = await h.call("GET", "/v1/usage", undefined, created.key);
    assert.equal(usage.status, 200);
    const outline = await h.call(
      "POST",
      "/v1/outlines",
      {
        source: {
          type: "manual",
          nodes: [{ name: "L1", printed_pages: { from: 1, to: 2 } }],
        },
      },
      created.key,
    );
    assert.equal(outline.status, 201);

    assert.equal(
      (await b.send("DELETE", `/page/keys/${created.id}`)).status,
      204,
    );
    const revoked = await h.call("GET", "/v1/usage", undefined, created.key);
    assert.equal(revoked.status, 401);
  });

  test("the page itself works on /v1/ through the sign-in cookie", async () => {
    const b = await signUp(h, "badr@example.com");
    const orgId = await newOrganisation(b, "Badr Academy");
    b.actFor(orgId);
    const usage = await b.json<{ balance: number }>("GET", "/v1/usage");
    assert.equal(usage.balance, 0);
    const created = await b.send("POST", "/v1/outlines", {
      source: {
        type: "manual",
        nodes: [{ name: "L1", printed_pages: { from: 1, to: 2 } }],
      },
    });
    assert.equal(created.status, 201);

    // A key that's sent is the only way in: a bad one never falls back to the cookie.
    const badKey = await b.send("GET", "/v1/usage", undefined, ORIGIN, {
      authorization: "Bearer eng_not-a-key",
    });
    assert.equal(badKey.status, 401);
  });

  test("a write from another origin, or none, is refused", async () => {
    const b = await signUp(h, "cross@example.com");
    await newOrganisation(b, "Cross Site");
    const body = { name: "x" };
    assert.equal(
      (await b.send("POST", "/page/keys", body, "https://evil.example")).status,
      403,
    );
    assert.equal((await b.send("POST", "/page/keys", body, null)).status, 403);
    assert.equal(
      (await b.send("POST", "/v1/outlines", body, "https://evil.example"))
        .status,
      403,
    );
    assert.equal(
      (await b.send("GET", "/page/keys", undefined, null)).status,
      200,
    );
  });
});

describe("organisations are walled off", () => {
  test("one organisation's documents, outlines and keys are 404 to another", async () => {
    const a = await signUp(h, "owner-a@example.com");
    const orgA = await newOrganisation(a, "Org A");
    const key = await a.json<{ id: string; key: string }>(
      "POST",
      "/page/keys",
      {
        name: "A",
      },
    );
    const outline = (await (
      await h.call(
        "POST",
        "/v1/outlines",
        {
          source: {
            type: "manual",
            nodes: [{ name: "L1", printed_pages: { from: 1, to: 2 } }],
          },
        },
        key.key,
      )
    ).json()) as { id: string };

    const b = await signUp(h, "owner-b@example.com");
    await newOrganisation(b, "Org B");
    assert.equal(
      (await b.send("GET", `/v1/outlines/${outline.id}`)).status,
      404,
    );
    assert.equal((await b.send("DELETE", `/page/keys/${key.id}`)).status, 404);
    assert.equal(
      (await h.call("GET", `/v1/outlines/${outline.id}`)).status,
      404,
      "and to the harness organisation's key",
    );

    // Naming an organisation you're not in doesn't get you into it.
    b.actFor(orgA);
    const me = await b.json<{ active: unknown }>("GET", "/page/me");
    assert.equal(me.active, null);
    assert.equal(
      (await b.send("GET", `/v1/outlines/${outline.id}`)).status,
      401,
    );
  });

  test("a member can't manage keys; owners can", async () => {
    const owner = await signUp(h, "owner-c@example.com");
    const orgId = await newOrganisation(owner, "Org C");
    const invitation = await owner.json<{ id: string }>(
      "POST",
      "/api/auth/organization/invite-member",
      { email: "member-c@example.com", role: "member", organizationId: orgId },
    );
    const member = await signUp(h, "member-c@example.com");
    await member.json("POST", "/api/auth/organization/accept-invitation", {
      invitationId: invitation.id,
    });
    member.actFor(orgId);
    const me = await member.json<{ active: { role: string } }>(
      "GET",
      "/page/me",
    );
    assert.equal(me.active.role, "member");
    assert.equal((await member.send("GET", "/page/keys")).status, 200);
    assert.equal(
      (await member.send("POST", "/page/keys", { name: "nope" })).status,
      403,
    );
  });

  test("organisations can't be deleted from the page", async () => {
    const owner = await signUp(h, "owner-d@example.com");
    const orgId = await newOrganisation(owner, "Org D");
    const response = await owner.send("POST", "/api/auth/organization/delete", {
      organizationId: orgId,
    });
    assert.notEqual(response.status, 200);
    const { rows } = await h.db.query(
      "SELECT 1 FROM organisations WHERE id = $1",
      [orgId],
    );
    assert.equal(rows.length, 1);
  });
});

test("the accounts migration matches Better Auth's schema", async () => {
  const { toBeCreated, toBeAdded } = await getMigrations(
    authOptions(h.db.pool, {
      baseURL: ORIGIN,
      secret: "x".repeat(32),
      google: undefined,
      trustedOrigins: [],
    }),
  );
  assert.deepEqual(
    {
      toBeCreated: toBeCreated.map((t) => t.table),
      toBeAdded: toBeAdded.map((t) => t.table),
    },
    { toBeCreated: [], toBeAdded: [] },
  );
});

describe("the page's own routes for books", () => {
  test("estimate, the books list and page images stay inside the organisation", async () => {
    const book = await h.runBook({
      pdf: makePdf(["one", "two"]),
      nodes: [{ name: "L", printed_pages: { from: 1, to: 2 } }],
    });

    // The harness organisation's books, seen by a member of another one.
    const other = await signUp(h, "outsider@example.com");
    await newOrganisation(other, "Outsiders");
    const list = await other.json<{ data: unknown[] }>(
      "GET",
      "/page/documents",
    );
    assert.deepEqual(list.data, []);
    assert.equal(
      (await other.send("GET", `/page/documents/${book.id}/pages/1`)).status,
      404,
    );

    // A member of the harness organisation sees them, by header or ?org=.
    const member = await signUp(h, "insider@example.com");
    const userId = (
      await h.db.query<{ id: string }>(
        "SELECT id FROM users WHERE email = $1",
        ["insider@example.com"],
      )
    ).rows[0]?.id;
    await h.db.query(
      "INSERT INTO members (id, org_id, user_id, role, created_at) VALUES ('mem_x', $1, $2, 'member', now())",
      [h.orgId, userId],
    );
    const image = await member.send(
      "GET",
      `/page/documents/${book.id}/pages/1?org=${h.orgId}`,
    );
    assert.equal(image.status, 302);
    assert.match(image.headers.get("location") ?? "", /local-storage/);
    member.actFor(h.orgId);
    const books = await member.json<{
      data: { id: string; title: string; status: string }[];
    }>("GET", "/page/documents");
    assert.ok(books.data.some((d) => d.id === book.id && d.title === "book"));

    const pdf = makePdf(["a", "b", "c"]);
    const uploadId = await h.upload(pdf, "application/pdf");
    const estimate = await member.json<{
      pages: number;
      balance: number;
      warning: unknown;
    }>("POST", "/page/estimate", { source: { upload_id: uploadId } });
    assert.equal(estimate.pages, 3);
    assert.ok(estimate.balance > 0);
    const foreign = await other.send("POST", "/page/estimate", {
      source: { upload_id: uploadId },
    });
    assert.equal(foreign.status, 404);
  });
});
