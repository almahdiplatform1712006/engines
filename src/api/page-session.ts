// Requests from Engines' page carry a sign-in cookie instead of an API key.
// Cookies go along on any request to this host, so a state-changing request
// must come from the page's own origin (CSRF), on top of SameSite=Lax cookies.
import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import type { Auth } from "../accounts/auth.ts";
import { pageSession, type PageSession } from "../accounts/sessions.ts";
import { findVisit, VISIT_COOKIE } from "../accounts/visits.ts";
import type { Clock } from "../shared/clock.ts";
import type { Queryable } from "../shared/db/pool.ts";
import { Refusal } from "../shared/refusal.ts";

export interface SessionDeps {
  auth: Auth;
  db: Queryable;
  /** PUBLIC_URL's origin plus any trusted origins (the Vite dev server). */
  origins: readonly string[];
  clock: Clock;
}

const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * The signed-in person or another platform's visitor (a visit wins: it's the
 * narrower of the two), or null; refuses a cross-origin write.
 */
export async function readSession(
  deps: SessionDeps,
  c: Context,
): Promise<PageSession | null> {
  const session =
    (await visitSession(deps, c)) ??
    // Links the page puts in <img> and <a download> can't send the header,
    // so a read may name the organisation as `?org=` instead. Writes can't.
    (await pageSession(
      deps.auth,
      deps.db,
      c.req.raw.headers,
      SAFE.has(c.req.method) ? (c.req.query("org") ?? null) : null,
    ));
  if (session && !SAFE.has(c.req.method)) {
    const origin = c.req.header("origin");
    if (!origin || !deps.origins.includes(origin)) {
      throw new Refusal(
        "forbidden",
        "This request must come from Engines' page.",
      );
    }
  }
  return session;
}

async function visitSession(
  deps: SessionDeps,
  c: Context,
): Promise<PageSession | null> {
  const cookie = getCookie(c, VISIT_COOKIE);
  if (!cookie) return null;
  const visit = await findVisit(deps.db, deps.clock, cookie);
  if (!visit) return null;
  return {
    user: { id: "visitor", name: "", email: "", superAdmin: false },
    active: { orgId: visit.orgId, role: "member" },
    visit,
  };
}

export function allowedOrigins(
  baseURL: string,
  trusted: readonly string[],
): string[] {
  return [new URL(baseURL).origin, ...trusted.map((o) => new URL(o).origin)];
}
