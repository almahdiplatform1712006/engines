// Engines' page, as a test sees it: a cookie jar, the page's Origin, and the
// organisation it acts for, calling the app directly.
import assert from "node:assert/strict";
import type { Harness } from "./harness.ts";

/** The harness app's own origin (its PUBLIC_URL). */
export const ORIGIN = "http://engines.test";

/** A browser: keeps cookies, sends the page's Origin. */
export type Browser = ReturnType<typeof browser>;

export function browser(h: Harness) {
  const jar = new Map<string, string>();
  let organisation: string | undefined;
  const send = async (
    method: string,
    path: string,
    body?: unknown,
    origin: string | null = ORIGIN,
    extra: Record<string, string> = {},
  ) => {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...extra,
    };
    if (origin) headers["origin"] = origin;
    if (jar.size > 0)
      headers["cookie"] = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    if (organisation) headers["engines-organisation"] = organisation;
    const response = await h.app.request(`${ORIGIN}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    for (const cookie of response.headers.getSetCookie()) {
      const [pair = ""] = cookie.split(";");
      const at = pair.indexOf("=");
      jar.set(pair.slice(0, at), pair.slice(at + 1));
    }
    return response;
  };
  return {
    send,
    json: async <T>(method: string, path: string, body?: unknown) => {
      const response = await send(method, path, body);
      const text = await response.text();
      assert.ok(
        response.ok,
        `${method} ${path}: ${String(response.status)} ${text}`,
      );
      return JSON.parse(text) as T;
    },
    actFor(orgId: string | undefined) {
      organisation = orgId;
    },
  };
}

export async function signUp(h: Harness, email: string) {
  const b = browser(h);
  await b.json("POST", "/api/auth/sign-up/email", {
    email,
    password: "a long enough password",
    name: email.split("@")[0],
  });
  return b;
}

export async function newOrganisation(b: Browser, name: string) {
  const org = await b.json<{ id: string }>(
    "POST",
    "/api/auth/organization/create",
    {
      name,
      slug: `${name.toLowerCase().replace(/\W+/g, "-")}-${String(Date.now())}`,
    },
  );
  return org.id;
}
