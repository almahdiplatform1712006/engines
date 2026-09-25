// The owner's back office (E-20, decision Q38), under `/page/admin/`: only
// the super admin's account gets in, checked on every request here on the
// server. Every change is written to the audit log in the same transaction
// as the change.
import { Hono } from "hono";
import { z } from "zod";
import { audit } from "../accounts/audit.ts";
import { balance, grantCredits, ledger } from "../accounts/credits.ts";
import {
  entitlementsOf,
  type Entitlement,
  grantEntitlement,
  revokeEntitlement,
} from "../accounts/entitlements.ts";
import type { PageSession } from "../accounts/sessions.ts";
import { latestResult } from "../documents/store.ts";
import type { Db } from "../shared/db/pool.ts";
import { Refusal } from "../shared/refusal.ts";
import { readBody, unauthorized } from "./errors.ts";
import { readSession, type SessionDeps } from "./page-session.ts";

interface Env {
  Variables: { admin: PageSession["user"] };
}

const ENTITLEMENTS = ["explanation"] as const satisfies readonly Entitlement[];

const GrantRequest = z.object({
  pages: z.int().min(1).max(10_000_000),
  note: z.string().trim().min(1).max(500),
});
const EntitlementRequest = z.object({ enabled: z.boolean() });
const KeyRequest = z
  .object({
    concurrency: z.int().min(1).max(50).optional(),
    max_queued: z.int().min(0).max(1000).optional(),
    provider: z.enum(["openrouter", "vertex"]).optional(),
  })
  .refine((k) => Object.keys(k).length > 0, "Send at least one setting.");

export function adminRoutes(deps: SessionDeps & { db: Db }): Hono<Env> {
  const { db } = deps;
  const admin = new Hono<Env>();

  admin.use(async (c, next) => {
    const session = await readSession(deps, c);
    if (!session) return unauthorized(c, "Sign in first.");
    if (!session.user.superAdmin) {
      throw new Refusal("forbidden", "The back office is for Engines' owner.");
    }
    c.set("admin", session.user);
    return next();
  });

  const organisationExists = async (id: string) => {
    const { rows } = await db.query(
      "SELECT 1 FROM organisations WHERE id = $1",
      [id],
    );
    if (rows.length === 0)
      throw new Refusal("not_found", `No organisation ${id}.`);
  };

  admin.get("/organisations", async (c) => {
    const q = (c.req.query("q") ?? "").trim();
    const { rows } = await db.query<{
      id: string;
      name: string;
      created_at: Date;
      balance: number;
      members: number;
      documents: number;
    }>(
      `SELECT o.id, o.name, o.created_at,
         (SELECT COALESCE(sum(pages), 0)::int FROM credit_ledger l WHERE l.org_id = o.id) AS balance,
         (SELECT count(*)::int FROM members m WHERE m.org_id = o.id) AS members,
         (SELECT count(*)::int FROM documents d WHERE d.org_id = o.id) AS documents
       FROM organisations o
       WHERE $1 = '' OR o.name ILIKE '%' || $2 || '%' ESCAPE '\\' OR o.id = $1
       ORDER BY o.created_at DESC LIMIT 200`,
      // % and _ in a search are the letters, not wildcards.
      [q, q.replace(/[\\%_]/g, (ch) => `\\${ch}`)],
    );
    return c.json({
      object: "list",
      data: rows.map((r) => ({ ...r, created_at: r.created_at.toISOString() })),
    });
  });

  admin.get("/organisations/:id", async (c) => {
    const id = c.req.param("id");
    const { rows } = await db.query<{ id: string; name: string }>(
      "SELECT id, name FROM organisations WHERE id = $1",
      [id],
    );
    const org = rows[0];
    if (!org) throw new Refusal("not_found", `No organisation ${id}.`);
    const members = await db.query<{
      name: string;
      email: string;
      role: string;
    }>(
      `SELECT u.name, u.email, m.role FROM members m JOIN users u ON u.id = m.user_id
       WHERE m.org_id = $1 ORDER BY m.created_at`,
      [id],
    );
    const keys = await db.query<{
      id: string;
      name: string;
      prefix: string;
      provider: string;
      concurrency: number;
      max_queued: number;
      built_in: boolean;
      revoked_at: Date | null;
    }>(
      `SELECT id, name, prefix, provider, concurrency, max_queued, built_in, revoked_at
       FROM api_keys WHERE org_id = $1 ORDER BY built_in DESC, created_at`,
      [id],
    );
    return c.json({
      ...org,
      balance: await balance(db, id),
      entitlements: await entitlementsOf(db, id),
      members: members.rows,
      keys: keys.rows.map((k) => ({
        ...k,
        revoked_at: k.revoked_at?.toISOString() ?? null,
      })),
      ledger: await ledger(db, id, 200),
    });
  });

  admin.post("/organisations/:id/credits", async (c) => {
    const id = c.req.param("id");
    const { pages, note } = await readBody(c, GrantRequest);
    await organisationExists(id);
    await db.transaction(async (tx) => {
      await grantCredits(tx, id, pages, note, c.var.admin.id);
      await audit(tx, {
        actorId: c.var.admin.id,
        orgId: id,
        action: "credits.grant",
        target: id,
        detail: { pages, note },
      });
    });
    return c.json({ balance: await balance(db, id) }, 201);
  });

  admin.put("/organisations/:id/entitlements/:name", async (c) => {
    const id = c.req.param("id");
    const name = c.req.param("name");
    if (!(ENTITLEMENTS as readonly string[]).includes(name))
      throw new Refusal("not_found", `No entitlement ${name}.`);
    const entitlement = name as Entitlement;
    const { enabled } = await readBody(c, EntitlementRequest);
    await organisationExists(id);
    await db.transaction(async (tx) => {
      if (enabled) await grantEntitlement(tx, id, entitlement);
      else await revokeEntitlement(tx, id, entitlement);
      await audit(tx, {
        actorId: c.var.admin.id,
        orgId: id,
        action: enabled ? "entitlement.grant" : "entitlement.revoke",
        target: entitlement,
      });
    });
    return c.json({ entitlements: await entitlementsOf(db, id) });
  });

  admin.patch("/keys/:id", async (c) => {
    const id = c.req.param("id");
    const change = await readBody(c, KeyRequest);
    const orgId = await db.transaction(async (tx) => {
      const { rows } = await tx.query<{ org_id: string }>(
        `UPDATE api_keys SET
           concurrency = COALESCE($2, concurrency),
           max_queued = COALESCE($3, max_queued),
           provider = COALESCE($4, provider)
         WHERE id = $1 RETURNING org_id`,
        [
          id,
          change.concurrency ?? null,
          change.max_queued ?? null,
          change.provider ?? null,
        ],
      );
      const row = rows[0];
      if (!row) throw new Refusal("not_found", `No key ${id}.`);
      await audit(tx, {
        actorId: c.var.admin.id,
        orgId: row.org_id,
        action: "key.update",
        target: id,
        detail: change,
      });
      return row.org_id;
    });
    return c.json({ id, org_id: orgId, ...change });
  });

  admin.post("/keys/:id/revoke", async (c) => {
    const id = c.req.param("id");
    await db.transaction(async (tx) => {
      const { rows } = await tx.query<{ org_id: string }>(
        `UPDATE api_keys SET revoked_at = COALESCE(revoked_at, now())
         WHERE id = $1 AND NOT built_in RETURNING org_id`,
        [id],
      );
      const row = rows[0];
      if (!row) throw new Refusal("not_found", `No key ${id} to revoke.`);
      await audit(tx, {
        actorId: c.var.admin.id,
        orgId: row.org_id,
        action: "key.revoke",
        target: id,
      });
    });
    return c.body(null, 204);
  });

  // Recent documents everywhere: status, pages, failures by reason, and the
  // model's cost per page (from the call log).
  admin.get("/documents", async (c) => {
    const status = c.req.query("status") ?? "";
    const { rows } = await db.query<{
      id: string;
      org_id: string;
      org_name: string;
      type: string;
      status: string;
      page_count: number | null;
      pages_billed: number | null;
      cost_usd: number;
      failures: Record<string, number> | null;
      created_at: Date;
    }>(
      `SELECT d.id, d.org_id, o.name AS org_name, d.type, d.status, d.page_count,
         d.pages_billed, d.created_at,
         (SELECT COALESCE(sum(cost_usd), 0) FROM model_calls m WHERE m.document_id = d.id) AS cost_usd,
         (SELECT jsonb_object_agg(reason, n) FROM (
            SELECT f->>'reason' AS reason, count(*)::int AS n
            FROM revisions r, jsonb_array_elements(r.result->'failures') f
            WHERE r.document_id = d.id AND r.number = d.revision
            GROUP BY 1) counts) AS failures
       FROM documents d JOIN organisations o ON o.id = d.org_id
       WHERE $1 = '' OR d.status = $1
       ORDER BY d.created_at DESC LIMIT 200`,
      [status],
    );
    return c.json({
      object: "list",
      data: rows.map((r) => ({
        ...r,
        failures: r.failures ?? {},
        created_at: r.created_at.toISOString(),
        // Only a finished document has its billed pages to divide by.
        cost_per_page:
          r.pages_billed !== null && r.pages_billed > 0
            ? r.cost_usd / r.pages_billed
            : null,
      })),
    });
  });

  admin.get("/documents/:id", async (c) => {
    const id = c.req.param("id");
    const { rows } = await db.query<{
      id: string;
      status: string;
      error: string | null;
    }>("SELECT id, status, error FROM documents WHERE id = $1", [id]);
    const doc = rows[0];
    if (!doc) throw new Refusal("not_found", `No document ${id}.`);
    const calls = await db.query<{
      purpose: string;
      model: string;
      calls: number;
      failed: number;
      cost_usd: number;
    }>(
      `SELECT purpose, model, count(*)::int AS calls, count(*) FILTER (WHERE NOT ok)::int AS failed,
         COALESCE(sum(cost_usd), 0) AS cost_usd
       FROM model_calls WHERE document_id = $1 GROUP BY purpose, model ORDER BY purpose`,
      [id],
    );
    const latest = await latestResult(db, id);
    return c.json({
      ...doc,
      failures: latest?.result.failures ?? [],
      calls: calls.rows,
    });
  });

  admin.get("/audit", async (c) => {
    const { rows } = await db.query<{
      id: number;
      actor: string | null;
      org_id: string | null;
      action: string;
      target: string | null;
      detail: unknown;
      created_at: Date;
    }>(
      `SELECT a.id, u.email AS actor, a.org_id, a.action, a.target, a.detail, a.created_at
       FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
       ORDER BY a.created_at DESC, a.id DESC LIMIT 200`,
    );
    return c.json({
      object: "list",
      data: rows.map((r) => ({ ...r, created_at: r.created_at.toISOString() })),
    });
  });

  return admin;
}
