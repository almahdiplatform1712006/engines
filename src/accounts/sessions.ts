// People signed in to Engines' page (E-15). A signed-in person acts for their
// active organisation, and only if they're still a member of it. On `/v1/`
// the page goes through the organisation's built-in key, so its documents
// share the per-key caps, idempotency and provider like any other key's.
import { randomBytes } from "node:crypto";
import type { Queryable } from "../shared/db/pool.ts";
import { newId } from "../shared/ids.ts";
import type { Auth } from "./auth.ts";
import { hashKey, type Caller } from "./keys.ts";
import type { Visit } from "./visits.ts";

export type Role = "owner" | "admin" | "member";

/**
 * Which organisation a page request acts for. The page keeps it in its own
 * URL and sends it on every call, so two tabs can work in two organisations.
 */
export const ORGANISATION_HEADER = "engines-organisation";

export interface PageUser {
  id: string;
  name: string;
  email: string;
  superAdmin: boolean;
}

export interface PageSession {
  user: PageUser;
  /** The organisation the person is acting for, with their role in it. */
  active: { orgId: string; role: Role } | null;
  /** Set when this is another platform's visitor (E-21), not a signed-in person. */
  visit?: Visit;
}

/**
 * The signed-in person behind a request's cookies, or null. They act for the
 * organisation the request names, else their session's active one, else
 * their first; always one they're a member of.
 */
export async function pageSession(
  auth: Auth,
  db: Queryable,
  headers: Headers,
  /** The organisation named another way (an image or download link's `?org=`). */
  named: string | null = null,
): Promise<PageSession | null> {
  const found = await auth.api.getSession({ headers });
  if (!found) return null;
  const { rows } = await db.query<{ super_admin: boolean }>(
    "SELECT super_admin FROM users WHERE id = $1",
    [found.user.id],
  );
  const user: PageUser = {
    id: found.user.id,
    name: found.user.name,
    email: found.user.email,
    superAdmin: rows[0]?.super_admin ?? false,
  };
  const orgId =
    headers.get(ORGANISATION_HEADER) ??
    named ??
    found.session.activeOrganizationId ??
    (await firstOrganisation(db, user.id));
  if (!orgId) return { user, active: null };
  const role = await memberRole(db, orgId, user.id);
  return { user, active: role ? { orgId, role } : null };
}

async function firstOrganisation(
  db: Queryable,
  userId: string,
): Promise<string | null> {
  const { rows } = await db.query<{ org_id: string }>(
    "SELECT org_id FROM members WHERE user_id = $1 ORDER BY created_at, id LIMIT 1",
    [userId],
  );
  return rows[0]?.org_id ?? null;
}

export async function memberRole(
  db: Queryable,
  orgId: string,
  userId: string,
): Promise<Role | null> {
  const { rows } = await db.query<{ role: string }>(
    "SELECT role FROM members WHERE org_id = $1 AND user_id = $2",
    [orgId, userId],
  );
  const role = rows[0]?.role;
  return role === undefined ? null : strongestRole(role);
}

/** Better Auth stores several roles comma-separated; the strongest counts. */
export function strongestRole(stored: string): Role {
  const roles = stored.split(",").map((r) => r.trim());
  if (roles.includes("owner")) return "owner";
  if (roles.includes("admin")) return "admin";
  return "member";
}

/** The page's caller on `/v1/`: the organisation's built-in key. */
export async function sessionCaller(
  db: Queryable,
  session: PageSession,
): Promise<Caller | null> {
  if (session.visit) {
    // A visit acts through the key that made its link.
    return {
      orgId: session.visit.orgId,
      apiKeyId: session.visit.apiKeyId,
      userId: null,
      visit: session.visit,
    };
  }
  if (!session.active) return null;
  const apiKeyId = await builtInKey(db, session.active.orgId);
  return { orgId: session.active.orgId, apiKeyId, userId: session.user.id };
}

/**
 * The organisation's built-in key, made on first use. Its secret is thrown
 * away at once: nobody can send it, only the page acts through it.
 */
export async function builtInKey(
  db: Queryable,
  orgId: string,
): Promise<string> {
  const find = async () => {
    const { rows } = await db.query<{ id: string }>(
      "SELECT id FROM api_keys WHERE org_id = $1 AND built_in AND revoked_at IS NULL",
      [orgId],
    );
    return rows[0]?.id;
  };
  const found = await find();
  if (found) return found;
  const secret = randomBytes(32).toString("base64url");
  // Two first calls at once: one insert wins, both then find it.
  await db.query(
    `INSERT INTO api_keys (id, org_id, name, hash, prefix, built_in)
     VALUES ($1, $2, 'Engines page', $3, 'page', true)
     ON CONFLICT (org_id) WHERE built_in AND revoked_at IS NULL DO NOTHING`,
    [newId("key"), orgId, hashKey(secret)],
  );
  const id = await find();
  if (!id) throw new Error(`no built-in key for ${orgId}`);
  return id;
}
