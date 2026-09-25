// Routes only Engines' page uses (E-15), behind a sign-in cookie: who's signed
// in, and the organisation's API keys. Everything else the page does goes
// through `/v1/` like any customer, or Better Auth's own `/api/auth/` routes.
import { Hono } from "hono";
import { z } from "zod";
import { createApiKey, listKeys, revokeKey } from "../accounts/keys.ts";
import { strongestRole, type PageSession } from "../accounts/sessions.ts";
import type { Queryable } from "../shared/db/pool.ts";
import { Refusal } from "../shared/refusal.ts";
import { readBody, unauthorized } from "./errors.ts";
import { readSession, type SessionDeps } from "./page-session.ts";

interface Env {
  Variables: { session: PageSession };
}

const CreateKeyRequest = z.object({ name: z.string().trim().min(1).max(100) });

export function pageRoutes(
  deps: SessionDeps & { db: Queryable; google: boolean },
): Hono<Env> {
  const { db } = deps;
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
    const { rows } = await db.query<{ id: string; name: string; role: string }>(
      `SELECT o.id, o.name, m.role FROM members m JOIN organisations o ON o.id = m.org_id
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

  page.delete("/keys/:id", async (c) => {
    const orgId = organisation(c.var.session, true);
    if (!(await revokeKey(db, orgId, c.req.param("id")))) {
      throw new Refusal("not_found", `No key ${c.req.param("id")}.`);
    }
    return c.body(null, 204);
  });

  return page;
}
