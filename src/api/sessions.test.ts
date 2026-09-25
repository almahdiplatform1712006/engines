// E-21: POST /v1/sessions makes a link that works once, expires, and signs
// its visitor in to one outline (and the documents run on it) or one
// document, never keys, the back office, other outlines or the usage.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { startHarness, type Harness } from "../../test/harness.ts";
import { mcq, page } from "../../test/model.ts";
import { ORIGIN } from "../../test/page-client.ts";
import { makePdf } from "../../test/pdf.ts";
import { scriptedReader } from "../reading/scripted.ts";

let h: Harness;
before(async () => {
  h = await startHarness({
    reader: () =>
      scriptedReader({ pages: { 1: page("1", [mcq("1", "سؤال")]) } }),
  });
});
after(() => h.close());

const tree = {
  source: {
    type: "manual",
    nodes: [
      {
        name: "درس",
        external_ref: "almahdi:lesson:1",
        printed_pages: { from: 1, to: 1 },
      },
    ],
  },
};

async function outline(key = h.key): Promise<string> {
  const response = await h.call("POST", "/v1/outlines", tree, key);
  return ((await response.json()) as { id: string }).id;
}

async function link(body: Record<string, unknown>, key = h.key) {
  const response = await h.call(
    "POST",
    "/v1/sessions",
    { return_url: "https://almahdi.example/course/7", ...body },
    key,
  );
  assert.equal(response.status, 201, await response.clone().text());
  return (await response.json()) as { url: string; expires_at: string };
}

/** Opens a link like a browser: the visit's cookie, and where it went. */
async function open(url: string) {
  const { pathname, search } = new URL(url);
  const response = await h.app.request(`${ORIGIN}${pathname}${search}`);
  const cookie = response.headers.getSetCookie()[0]?.split(";")[0] ?? "";
  return { response, cookie };
}

function visitor(cookie: string) {
  return (method: string, path: string, body?: unknown, origin = ORIGIN) =>
    h.app.request(`${ORIGIN}${path}`, {
      method,
      headers: {
        cookie,
        origin,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
}

describe("a session link", () => {
  test("works once, then is refused; an expired one never works", async () => {
    const outlineId = await outline();
    const { url, expires_at } = await link({ outline_id: outlineId });
    assert.match(url, /\/page\/enter\?token=/);
    assert.ok(new Date(expires_at).getTime() - Date.now() <= 10 * 60 * 1000);

    const first = await open(url);
    assert.equal(first.response.status, 302);
    assert.equal(
      first.response.headers.get("location"),
      `/o/${h.orgId}/outlines/${outlineId}`,
    );
    assert.equal(first.response.headers.get("referrer-policy"), "no-referrer");
    assert.match(first.cookie, /^engines_visit=/);
    assert.equal((await open(url)).response.status, 410, "used once");

    const late = await link({ outline_id: outlineId });
    await h.db.query(
      "UPDATE visitor_links SET expires_at = now() - interval '1 second' WHERE used_at IS NULL",
    );
    assert.equal((await open(late.url)).response.status, 410, "expired");
  });

  test("reaches its outline and the documents run on it, nothing else", async () => {
    const outlineId = await outline();
    const other = await outline();
    const { cookie } = await open((await link({ outline_id: outlineId })).url);
    const as = visitor(cookie);

    const me = (await (await as("GET", "/page/me")).json()) as {
      user: unknown;
      visit: { return_url: string; outline_id: string };
    };
    assert.equal(me.user, null);
    assert.equal(me.visit.return_url, "https://almahdi.example/course/7");

    assert.equal((await as("GET", `/v1/outlines/${outlineId}`)).status, 200);
    assert.equal((await as("GET", `/v1/outlines/${other}`)).status, 404);
    // Editing keeps external_ref on the node the reviewer renamed.
    const got = (await (
      await as("GET", `/v1/outlines/${outlineId}`)
    ).json()) as {
      nodes: { id: string; name: string; external_ref: string | null }[];
    };
    const [node] = got.nodes;
    assert.ok(node);
    const renamed = await as("PUT", `/v1/outlines/${outlineId}`, {
      nodes: [
        { ...node, name: "درس معدّل", printed_pages: { from: 1, to: 1 } },
      ],
    });
    assert.equal(renamed.status, 200);
    assert.equal(
      (await as("POST", `/v1/outlines/${outlineId}/confirm`)).status,
      200,
    );

    // Runs the book on its outline, through the key that made the link.
    const pdf = makePdf(["one"]);
    const upload = (await (
      await as("POST", "/v1/uploads", {
        filename: "b.pdf",
        content_type: "application/pdf",
        size: pdf.length,
      })
    ).json()) as { id: string; upload_url: string };
    const put = new URL(upload.upload_url);
    await h.app.request(put.pathname + put.search, {
      method: "PUT",
      body: pdf,
    });
    const created = await as("POST", "/v1/documents", {
      outline_id: outlineId,
      type: "questions",
      source: { upload_id: upload.id },
    });
    assert.equal(created.status, 202, await created.clone().text());
    const { id: documentId } = (await created.json()) as { id: string };
    assert.equal((await as("GET", `/v1/documents/${documentId}`)).status, 200);
    const { rows } = await h.db.query<{ api_key_id: string }>(
      "SELECT api_key_id FROM documents WHERE id = $1",
      [documentId],
    );
    assert.equal(rows[0]?.api_key_id, h.apiKeyId);

    // Its placed items carry the node's external_ref.
    await h.waitFor(documentId, ["awaiting_offset"]);
    await h.call("POST", `/v1/documents/${documentId}/offset`, {
      segments: [{ printed_from: 1, pdf_from: 1 }],
    });
    const done = (await h.waitFor(documentId, [
      "completed",
      "completed_with_errors",
    ])) as { questions: { external_ref: string | null }[] };
    assert.deepEqual(
      done.questions.map((q) => q.external_ref),
      ["almahdi:lesson:1"],
    );

    // Not on another outline, and nothing outside the flow.
    assert.equal(
      (
        await as("POST", "/v1/documents", {
          outline_id: other,
          type: "questions",
          source: { upload_id: upload.id },
        })
      ).status,
      404,
    );
    for (const [method, path] of [
      ["POST", "/v1/outlines"],
      ["GET", "/v1/usage"],
      ["GET", "/v1/webhook_secret"],
      ["POST", "/v1/sessions"],
      ["GET", "/page/keys"],
      ["GET", "/page/documents"],
      ["GET", "/page/admin/organisations"],
    ] as const) {
      assert.equal(
        (await as(method, path, method === "POST" ? {} : undefined)).status,
        403,
        `${method} ${path}`,
      );
    }
    // Writes must come from the page.
    assert.equal(
      (
        await as(
          "POST",
          `/v1/outlines/${outlineId}/confirm`,
          undefined,
          "https://evil.example",
        )
      ).status,
      403,
    );
  });

  test("a document link reaches that document and its outline only", async () => {
    const doc = await h.runBook({
      pdf: makePdf(["one"]),
      nodes: [{ name: "L", printed_pages: { from: 1, to: 1 } }],
    });
    const otherDoc = await h.runBook({
      pdf: makePdf(["two"]),
      nodes: [{ name: "L", printed_pages: { from: 1, to: 1 } }],
    });
    const { response, cookie } = await open(
      (await link({ document_id: doc.id })).url,
    );
    assert.equal(
      response.headers.get("location"),
      `/o/${h.orgId}/documents/${doc.id}`,
    );
    const as = visitor(cookie);
    assert.equal((await as("GET", `/v1/documents/${doc.id}`)).status, 200);
    assert.equal(
      (await as("GET", `/v1/outlines/${doc.outline_id}`)).status,
      200,
    );
    assert.equal((await as("GET", `/v1/documents/${otherDoc.id}`)).status, 404);
    assert.equal(
      (await as("GET", `/page/documents/${doc.id}/pages/1`)).status,
      302,
    );
    assert.equal(
      (await as("GET", `/page/documents/${otherDoc.id}/pages/1`)).status,
      404,
    );
  });

  test("only a key makes links, for its own organisation; revoking the key ends the visit", async () => {
    const stranger = await h.newKey("Stranger");
    const strangers = await outline(stranger.key);
    const refused = await h.call(
      "POST",
      "/v1/sessions",
      { outline_id: strangers, return_url: "https://x.example" },
      h.key,
    );
    assert.equal(refused.status, 404);
    const both = await h.call("POST", "/v1/sessions", {
      outline_id: strangers,
      document_id: "doc_x",
      return_url: "https://x.example",
    });
    assert.equal(both.status, 400);

    const { cookie } = await open(
      (await link({ outline_id: strangers }, stranger.key)).url,
    );
    const as = visitor(cookie);
    assert.equal((await as("GET", `/v1/outlines/${strangers}`)).status, 200);
    await h.db.query("UPDATE api_keys SET revoked_at = now() WHERE id = $1", [
      stranger.apiKeyId,
    ]);
    assert.equal((await as("GET", `/v1/outlines/${strangers}`)).status, 401);
  });
});

test("a visit's documents report to the link's webhook, whatever the page sends", async () => {
  const outlineId = await outline();
  await h.call("POST", `/v1/outlines/${outlineId}/confirm`);
  const { cookie } = await open(
    (
      await link({
        outline_id: outlineId,
        webhook_url: "http://127.0.0.1:9/almahdi-hook",
      })
    ).url,
  );
  const as = visitor(cookie);
  const pdf = makePdf(["one"]);
  const upload = (await (
    await as("POST", "/v1/uploads", {
      filename: "b.pdf",
      content_type: "application/pdf",
      size: pdf.length,
    })
  ).json()) as { id: string; upload_url: string };
  const put = new URL(upload.upload_url);
  await h.app.request(put.pathname + put.search, { method: "PUT", body: pdf });
  const created = (await (
    await as("POST", "/v1/documents", {
      outline_id: outlineId,
      type: "questions",
      source: { upload_id: upload.id },
      webhook_url: "http://127.0.0.1:9/somewhere-else",
    })
  ).json()) as { id: string };
  const { rows } = await h.db.query<{ webhook_url: string | null }>(
    "SELECT webhook_url FROM documents WHERE id = $1",
    [created.id],
  );
  assert.equal(rows[0]?.webhook_url, "http://127.0.0.1:9/almahdi-hook");
});

test("someone signed in is asked before a link makes them a visitor; leaving ends the visit", async () => {
  const outlineId = await outline();
  const { url } = await link({ outline_id: outlineId });
  const signUp = await h.app.request(`${ORIGIN}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { origin: ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({
      email: "signed-in@example.com",
      password: "a long enough password",
      name: "S",
    }),
  });
  const session = signUp.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  const { pathname, search } = new URL(url);
  const asked = await h.app.request(`${ORIGIN}${pathname}${search}`, {
    headers: { cookie: session },
  });
  assert.equal(asked.status, 200);
  assert.match(await asked.text(), /switch=1/);

  const switched = await h.app.request(
    `${ORIGIN}${pathname}${search}&switch=1`,
    {
      headers: { cookie: session },
    },
  );
  assert.equal(switched.status, 302, "the token wasn't used by the question");
  const visit = switched.headers.getSetCookie()[0]?.split(";")[0] ?? "";

  const left = await h.app.request(`${ORIGIN}/page/leave-visit`, {
    method: "POST",
    headers: { cookie: visit, origin: ORIGIN },
  });
  assert.equal(left.status, 204);
  assert.match(
    left.headers.getSetCookie()[0] ?? "",
    /engines_visit=;.*Max-Age=0/,
  );
});
