// Organisations and their API keys. Keys are Engines' own, not Better Auth's
// (ADR 0002): hashed at rest, each with its own caps and model provider.
import { createHash, randomBytes } from "node:crypto";
import type { Queryable } from "../shared/db/pool.ts";
import { newId } from "../shared/ids.ts";
import type { Visit } from "./visits.ts";

export interface Caller {
  orgId: string;
  apiKeyId: string;
  /** The person on Engines' page, when the call came from there. */
  userId: string | null;
  /** Another platform's visitor on the page, limited to its outline or document. */
  visit?: Visit;
}

export interface KeyView {
  id: string;
  name: string;
  prefix: string;
  provider: string;
  created_at: string;
  revoked_at: string | null;
}

export interface CreatedKey {
  id: string;
  /** The whole key. Shown once; only its hash is stored. */
  key: string;
}

const KEY_PREFIX = "eng_";

export function hashKey(key: string): Buffer {
  return createHash("sha256").update(key).digest();
}

export async function createOrganisation(
  db: Queryable,
  name: string,
): Promise<string> {
  const id = newId("org");
  // The slug is Better Auth's; an organisation made outside the page uses its id.
  await db.query(
    "INSERT INTO organisations (id, name, slug) VALUES ($1, $2, $1)",
    [id, name],
  );
  return id;
}

export async function createApiKey(
  db: Queryable,
  orgId: string,
  name: string,
  createdBy: string | null = null,
): Promise<CreatedKey> {
  const id = newId("key");
  const key = `${KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
  await db.query(
    "INSERT INTO api_keys (id, org_id, name, hash, prefix, created_by) VALUES ($1, $2, $3, $4, $5, $6)",
    [id, orgId, name, hashKey(key), key.slice(0, 12), createdBy],
  );
  return { id, key };
}

/** An organisation's keys, newest first; the page's built-in key isn't one. */
export async function listKeys(
  db: Queryable,
  orgId: string,
): Promise<KeyView[]> {
  const { rows } = await db.query<{
    id: string;
    name: string;
    prefix: string;
    provider: string;
    created_at: Date;
    revoked_at: Date | null;
  }>(
    `SELECT id, name, prefix, provider, created_at, revoked_at FROM api_keys
     WHERE org_id = $1 AND NOT built_in ORDER BY created_at DESC, id`,
    [orgId],
  );
  return rows.map((r) => ({
    ...r,
    created_at: r.created_at.toISOString(),
    revoked_at: r.revoked_at?.toISOString() ?? null,
  }));
}

/** Revokes one of the organisation's keys; false when it has no such key. */
export async function revokeKey(
  db: Queryable,
  orgId: string,
  keyId: string,
): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE api_keys SET revoked_at = COALESCE(revoked_at, now())
     WHERE id = $1 AND org_id = $2 AND NOT built_in`,
    [keyId, orgId],
  );
  return rowCount === 1;
}

/** The caller behind an `Authorization: Bearer` header, or null for a missing, unknown or revoked key. */
export async function authenticateKey(
  db: Queryable,
  authorization: string | undefined,
): Promise<Caller | null> {
  const match = /^Bearer\s+(\S+)$/i.exec(authorization ?? "");
  const key = match?.[1];
  if (!key?.startsWith(KEY_PREFIX)) return null;
  const { rows } = await db.query<{ id: string; org_id: string }>(
    "SELECT id, org_id FROM api_keys WHERE hash = $1 AND revoked_at IS NULL AND NOT built_in",
    [hashKey(key)],
  );
  const row = rows[0];
  return row ? { orgId: row.org_id, apiKeyId: row.id, userId: null } : null;
}
