// The back office's audit log (E-20): who changed what, when. Written in the
// same transaction as the change, so there's never one without the other.
import type { Queryable } from "../shared/db/pool.ts";

export interface AuditEntry {
  actorId: string;
  orgId: string | null;
  action: string;
  target: string | null;
  detail?: Record<string, unknown>;
}

export async function audit(tx: Queryable, entry: AuditEntry): Promise<void> {
  await tx.query(
    `INSERT INTO audit_log (actor_id, org_id, action, target, detail)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      entry.actorId,
      entry.orgId,
      entry.action,
      entry.target,
      JSON.stringify(entry.detail ?? {}),
    ],
  );
}
