// Entitlements: switches on an organisation (E-12). `explanation` gates the
// explanation and both document types, and the `explanation` field of results.
import type { Queryable } from "../shared/db/pool.ts";
import { Refusal } from "../shared/refusal.ts";

export type Entitlement = "explanation";

export async function hasEntitlement(
  db: Queryable,
  orgId: string,
  name: Entitlement,
): Promise<boolean> {
  const { rows } = await db.query(
    "SELECT 1 FROM entitlements WHERE org_id = $1 AND name = $2",
    [orgId, name],
  );
  return rows.length > 0;
}

export async function grantEntitlement(
  db: Queryable,
  orgId: string,
  name: Entitlement,
): Promise<void> {
  await db.query(
    "INSERT INTO entitlements (org_id, name) VALUES ($1, $2) ON CONFLICT DO NOTHING",
    [orgId, name],
  );
}

export async function revokeEntitlement(
  db: Queryable,
  orgId: string,
  name: Entitlement,
): Promise<void> {
  await db.query("DELETE FROM entitlements WHERE org_id = $1 AND name = $2", [
    orgId,
    name,
  ]);
}

export async function requireEntitlement(
  db: Queryable,
  orgId: string,
  name: Entitlement,
): Promise<void> {
  if (!(await hasEntitlement(db, orgId, name))) {
    throw new Refusal(
      "not_entitled",
      `This organisation isn't entitled to ${name}. Ask Engines to switch it on.`,
    );
  }
}

export async function entitlementsOf(
  db: Queryable,
  orgId: string,
): Promise<Entitlement[]> {
  const { rows } = await db.query<{ name: Entitlement }>(
    "SELECT name FROM entitlements WHERE org_id = $1 ORDER BY name",
    [orgId],
  );
  return rows.map((r) => r.name);
}
