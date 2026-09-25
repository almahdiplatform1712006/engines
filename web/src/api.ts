// Calls from the page. The sign-in cookie goes along; the organisation the
// page is showing (from its URL) is named on every call.
import { createAuthClient } from "better-auth/react";
import { organizationClient } from "better-auth/client/plugins";

export const authClient = createAuthClient({
  plugins: [organizationClient()],
});

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function api<T>(
  method: string,
  path: string,
  options: { orgId?: string | undefined; body?: unknown } = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  if (options.orgId) headers["engines-organisation"] = options.orgId;
  if (options.body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(path, {
    method,
    headers,
    credentials: "same-origin",
    ...(options.body === undefined
      ? {}
      : { body: JSON.stringify(options.body) }),
  });
  if (response.status === 204) return undefined as T;
  const body = (await response.json().catch(() => null)) as {
    error?: { code: string; message: string };
  } | null;
  if (!response.ok) {
    throw new ApiError(
      response.status,
      body?.error?.code ?? "internal",
      body?.error?.message ?? response.statusText,
    );
  }
  return body as T;
}

export interface Me {
  /** Null for another platform's visitor (E-21). */
  user: {
    id: string;
    name: string;
    email: string;
    super_admin: boolean;
  } | null;
  /** Set for a visitor: where "back" goes and what the visit reaches. */
  visit?: {
    return_url: string;
    outline_id: string | null;
    document_id: string | null;
  };
  organisations: {
    id: string;
    name: string;
    role: string;
    entitlements: string[];
  }[];
  active: { id: string; role: string } | null;
}
