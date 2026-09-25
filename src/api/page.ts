// Routes only Engines' page uses (E-15), behind a sign-in cookie: who's signed
// in, and the organisation's API keys. Everything else the page does goes
// through `/v1/` like any customer, or Better Auth's own `/api/auth/` routes.
import { Hono } from "hono";
import { z } from "zod";
import { createApiKey, listKeys, revokeKey } from "../accounts/keys.ts";
import { strongestRole, type PageSession } from "../accounts/sessions.ts";
import { balance } from "../accounts/credits.ts";
import { CreateDocumentRequest } from "../contract/document.ts";
import { examineBook } from "../documents/create.ts";
import { liveDocument } from "../documents/store.ts";
import type { Clock } from "../shared/clock.ts";
import type { Db } from "../shared/db/pool.ts";
import type { BlobStore } from "../storage/store.ts";
import { Refusal } from "../shared/refusal.ts";
import { readBody, unauthorized } from "./errors.ts";
import { readSession, type SessionDeps } from "./page-session.ts";

interface Env {
  Variables: { session: PageSession };
}

const CreateKeyRequest = z.object({ name: z.string().trim().min(1).max(100) });
const EstimateRequest = CreateDocumentRequest.pick({ source: true });

/** How long a redirected page image link lasts. */
const PAGE_URL_SECONDS = 15 * 60;

export function pageRoutes(
  deps: SessionDeps & {
    db: Db;
    store: BlobStore;
    clock: Clock;
    google: boolean;
  },
): Hono<Env> {
  const { db, store } = deps;
  const page = new Hono<Env>();

  // Before sign-in: which ways in the page offers.
  page.get("/config", (c) => c.json({ google: deps.google }));

  page.use(async (c, next) => {
    const session = await readSession(deps, c);
    if (!session) return unauthorized(c, "Sign in first.");
    c.set("session", session);
    return next();
  });

  page.get("/me", async (c) => {
    const { user, active } = c.var.session;
    const { rows } = await db.query<{
      id: string;
      name: string;
      role: string;
      entitlements: string[];
    }>(
      `SELECT o.id, o.name, m.role,
         ARRAY(SELECT e.name FROM entitlements e WHERE e.org_id = o.id ORDER BY e.name) AS entitlements
       FROM members m JOIN organisations o ON o.id = m.org_id
       WHERE m.user_id = $1 ORDER BY m.created_at, o.id`,
      [user.id],
    );
    return c.json({
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        super_admin: user.superAdmin,
      },
      organisations: rows.map((o) => ({ ...o, role: strongestRole(o.role) })),
      active: active ? { id: active.orgId, role: active.role } : null,
    });
  });

  /** The acting organisation, refusing when the person isn't in one. */
  const organisation = (session: PageSession, manage = false) => {
    if (!session.active)
      throw new Refusal("not_found", "Create or join an organisation first.");
    if (manage && session.active.role === "member") {
      throw new Refusal(
        "forbidden",
        "Only the organisation's owners and admins manage API keys.",
      );
    }
    return session.active.orgId;
  };

  page.get("/keys", async (c) => {
    const orgId = organisation(c.var.session);
    return c.json({ object: "list", data: await listKeys(db, orgId) });
  });

  page.post("/keys", async (c) => {
    const orgId = organisation(c.var.session, true);
    const { name } = await readBody(c, CreateKeyRequest);
    const created = await createApiKey(db, orgId, name, c.var.session.user.id);
    return c.json({ id: created.id, name, key: created.key }, 201);
  });

  // Before a document is created: what the uploaded book is and costs.
  page.post("/estimate", async (c) => {
    const orgId = organisation(c.var.session);
    const { source } = await readBody(c, EstimateRequest);
    const book = await examineBook(deps, orgId, source);
    return c.json({
      pages: book.pageCount,
      balance: await balance(db, orgId),
      warning: book.warning,
    });
  });

  page.get("/documents", async (c) => {
    const orgId = organisation(c.var.session);
    const { rows } = await db.query<{
      id: string;
      type: string;
      status: string;
      pages: number | null;
      pages_read: number;
      filename: string | null;
      created_at: Date;
    }>(
      `SELECT d.id, d.type, d.status, d.page_count AS pages, d.created_at,
         (SELECT count(*)::int FROM pages p WHERE p.document_id = d.id AND p.state <> 'pending') AS pages_read,
         (SELECT u.filename FROM uploads u WHERE u.org_id = d.org_id AND u.document_id = d.id ORDER BY u.created_at, u.id LIMIT 1) AS filename
       FROM documents d WHERE d.org_id = $1 AND d.expired_at IS NULL
       ORDER BY d.created_at DESC, d.id LIMIT 200`,
      [orgId],
    );
    return c.json({
      object: "list",
      data: rows.map(({ filename, created_at, ...row }) => ({
        ...row,
        title: filename?.replace(/\.[^.]+$/, "") ?? row.id,
        created_at: created_at.toISOString(),
      })),
    });
  });

  // A page of a book, as the pipeline rendered it: thumbnails on the offset
  // screen and page images in review load straight from here.
  page.get("/documents/:id/pages/:page", async (c) => {
    const orgId = organisation(c.var.session);
    const row = await liveDocument(db, orgId, c.req.param("id"));
    const pdfPage = Number(c.req.param("page"));
    if (!Number.isSafeInteger(pdfPage) || pdfPage < 1)
      throw new Refusal("not_found", "No such page.");
    const { rows } = await db.query<{ image_key: string }>(
      "SELECT image_key FROM pages WHERE document_id = $1 AND pdf_page = $2",
      [row.id, pdfPage],
    );
    const key = rows[0]?.image_key;
    if (!key) throw new Refusal("not_found", "No such page.");
    c.header("cache-control", "private, max-age=300");
    return c.redirect(await store.signedUrl(key, PAGE_URL_SECONDS), 302);
  });

  page.delete("/keys/:id", async (c) => {
    const orgId = organisation(c.var.session, true);
    if (!(await revokeKey(db, orgId, c.req.param("id")))) {
      throw new Refusal("not_found", `No key ${c.req.param("id")}.`);
    }
    return c.body(null, 204);
  });

  return page;
}
