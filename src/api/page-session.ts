// Requests from Engines' page carry a sign-in cookie instead of an API key.
// Cookies go along on any request to this host, so a state-changing request
// must come from the page's own origin (CSRF), on top of SameSite=Lax cookies.
import type { Context } from "hono";
import type { Auth } from "../accounts/auth.ts";
import { pageSession, type PageSession } from "../accounts/sessions.ts";
import type { Queryable } from "../shared/db/pool.ts";
import { Refusal } from "../shared/refusal.ts";

export interface SessionDeps {
  auth: Auth;
  db: Queryable;
  /** PUBLIC_URL's origin plus any trusted origins (the Vite dev server). */
  origins: readonly string[];
}

const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

/** The signed-in person, or null; refuses a cross-origin write. */
export async function readSession(
  deps: SessionDeps,
  c: Context,
): Promise<PageSession | null> {
  const session = await pageSession(deps.auth, deps.db, c.req.raw.headers);
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

export function allowedOrigins(
  baseURL: string,
  trusted: readonly string[],
): string[] {
  return [new URL(baseURL).origin, ...trusted.map((o) => new URL(o).origin)];
}
