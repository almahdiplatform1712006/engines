// Organisations and their API keys (E-05, minimal). Better Auth takes over in
// E-15 behind the same `authenticate` function, so `/v1/` doesn't change.
import { createHash, randomBytes } from "node:crypto";
import type { Queryable } from "../shared/db/pool.ts";
import { newId } from "../shared/ids.ts";

export interface Caller {
  orgId: string;
  apiKeyId: string;
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
  await db.query("INSERT INTO organisations (id, name) VALUES ($1, $2)", [
    id,
    name,
  ]);
  return id;
}

export async function createApiKey(
  db: Queryable,
  orgId: string,
  name: string,
): Promise<CreatedKey> {
  const id = newId("key");
  const key = `${KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
  await db.query(
    "INSERT INTO api_keys (id, org_id, name, hash, prefix) VALUES ($1, $2, $3, $4, $5)",
    [id, orgId, name, hashKey(key), key.slice(0, 12)],
  );
  return { id, key };
}

/** The caller behind an `Authorization: Bearer` header, or null for a missing, unknown or revoked key. */
export async function authenticate(
  db: Queryable,
  authorization: string | undefined,
): Promise<Caller | null> {
  const match = /^Bearer\s+(\S+)$/i.exec(authorization ?? "");
  const key = match?.[1];
  if (!key?.startsWith(KEY_PREFIX)) return null;
  const { rows } = await db.query<{ id: string; org_id: string }>(
    "SELECT id, org_id FROM api_keys WHERE hash = $1 AND revoked_at IS NULL",
    [hashKey(key)],
  );
  const row = rows[0];
  return row ? { orgId: row.org_id, apiKeyId: row.id } : null;
}
