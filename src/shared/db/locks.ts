// Transaction-scoped advisory locks, each kind in its own namespace so a key id
// and an organisation id can never collide on one lock.
import type { Queryable } from "./pool.ts";

const NAMESPACE = { apiKey: 1, orgCredits: 2 } as const;

/** Serialises admission and the queue check for one API key. */
export async function lockApiKey(
  tx: Queryable,
  apiKeyId: string,
): Promise<void> {
  await tx.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [
    NAMESPACE.apiKey,
    apiKeyId,
  ]);
}

/** Serialises credit holds for one organisation. */
export async function lockOrgCredits(
  tx: Queryable,
  orgId: string,
): Promise<void> {
  await tx.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [
    NAMESPACE.orgCredits,
    orgId,
  ]);
}
