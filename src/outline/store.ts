// Outlines in Postgres: a row per outline and a row per node (spec #1 §6).
import type {
  Outline,
  OutlineNode,
  OutlineStatus,
} from "../contract/outline.ts";
import { addDays, type Clock } from "../shared/clock.ts";
import type { Db, Queryable } from "../shared/db/pool.ts";
import { newId } from "../shared/ids.ts";
import { Refusal } from "../shared/refusal.ts";
import { validateOutline, walk } from "./tree.ts";

/** A draft or unused confirmed outline expires after this many days (spec §3). */
export const OUTLINE_TTL_DAYS = 30;

export interface StoredOutline {
  id: string;
  orgId: string;
  status: OutlineStatus;
  nodes: OutlineNode[];
  createdAt: Date;
  expiresAt: Date;
}

interface OutlineRow {
  id: string;
  org_id: string;
  status: OutlineStatus;
  created_at: Date;
  expires_at: Date;
}

interface NodeRow {
  id: string;
  parent_id: string | null;
  name: string;
  level: string | null;
  printed_from: number | null;
  printed_to: number | null;
  kind: "content" | "answer_key";
  external_ref: string | null;
}

export function outlineView(outline: StoredOutline): Outline {
  const { errors, warnings } = validateOutline(outline.nodes);
  return {
    id: outline.id,
    object: "outline",
    status: outline.status,
    nodes: outline.nodes,
    errors,
    warnings,
    created_at: outline.createdAt.toISOString(),
    expires_at: outline.expiresAt.toISOString(),
  };
}

export async function createOutline(
  db: Db,
  clock: Clock,
  orgId: string,
  source: unknown,
  nodes: OutlineNode[],
): Promise<StoredOutline> {
  const id = newId("out");
  const now = clock();
  await db.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO outlines (id, org_id, status, source, created_at, updated_at, expires_at)
       VALUES ($1, $2, 'draft', $3, $4, $4, $5)`,
      [id, orgId, JSON.stringify(source), now, addDays(now, OUTLINE_TTL_DAYS)],
    );
    await writeNodes(tx, id, orgId, nodes);
  });
  const outline = await getOutline(db, orgId, id);
  if (!outline) throw new Error("outline vanished after insert");
  return outline;
}

/** The organisation's outline, or null when it doesn't exist or belongs to someone else. */
export async function getOutline(
  db: Queryable,
  orgId: string,
  id: string,
): Promise<StoredOutline | null> {
  const { rows } = await db.query<OutlineRow>(
    "SELECT id, org_id, status, created_at, expires_at FROM outlines WHERE id = $1 AND org_id = $2",
    [id, orgId],
  );
  const row = rows[0];
  if (!row) return null;
  const nodes = await db.query<NodeRow>(
    `SELECT id, parent_id, name, level, printed_from, printed_to, kind, external_ref
     FROM outline_nodes WHERE outline_id = $1 ORDER BY position`,
    [id],
  );
  return {
    id: row.id,
    orgId: row.org_id,
    status: row.status,
    nodes: buildTree(nodes.rows),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

export async function replaceOutline(
  db: Db,
  clock: Clock,
  orgId: string,
  id: string,
  nodes: OutlineNode[],
): Promise<StoredOutline> {
  await db.transaction(async (tx) => {
    const status = await lockStatus(tx, orgId, id);
    if (status !== "draft") {
      throw new Refusal(
        "outline_frozen",
        "A confirmed outline can't be changed. Start a new outline instead.",
      );
    }
    await tx.query("DELETE FROM outline_nodes WHERE outline_id = $1", [id]);
    await writeNodes(tx, id, orgId, nodes);
    await tx.query("UPDATE outlines SET updated_at = $2 WHERE id = $1", [
      id,
      clock(),
    ]);
  });
  return mustGet(db, orgId, id);
}

/** Freezes the tree. Refused while it has errors (spec §1 step 3). */
export async function confirmOutline(
  db: Db,
  clock: Clock,
  orgId: string,
  id: string,
): Promise<StoredOutline> {
  await db.transaction(async (tx) => {
    const status = await lockStatus(tx, orgId, id);
    if (status !== "draft") return; // confirming twice is harmless
    const outline = await mustGet(tx, orgId, id);
    const { errors } = validateOutline(outline.nodes);
    if (errors.length > 0) {
      throw new Refusal(
        "outline_invalid",
        "The outline has errors to fix before it can be confirmed.",
        {
          details: { errors },
        },
      );
    }
    const now = clock();
    await tx.query(
      "UPDATE outlines SET status = 'confirmed', confirmed_at = $2, updated_at = $2, expires_at = $3 WHERE id = $1",
      [id, now, addDays(now, OUTLINE_TTL_DAYS)],
    );
  });
  return mustGet(db, orgId, id);
}

/** A confirmed outline becomes in_use when a document runs against it. */
export async function markInUse(db: Queryable, id: string): Promise<void> {
  await db.query(
    "UPDATE outlines SET status = 'in_use' WHERE id = $1 AND status = 'confirmed'",
    [id],
  );
}

async function lockStatus(
  tx: Queryable,
  orgId: string,
  id: string,
): Promise<OutlineStatus> {
  const { rows } = await tx.query<{ status: OutlineStatus }>(
    "SELECT status FROM outlines WHERE id = $1 AND org_id = $2 FOR UPDATE",
    [id, orgId],
  );
  const row = rows[0];
  if (!row) throw new Refusal("not_found", `No outline ${id}.`);
  return row.status;
}

async function mustGet(
  db: Queryable,
  orgId: string,
  id: string,
): Promise<StoredOutline> {
  const outline = await getOutline(db, orgId, id);
  if (!outline) throw new Refusal("not_found", `No outline ${id}.`);
  return outline;
}

async function writeNodes(
  tx: Queryable,
  outlineId: string,
  orgId: string,
  nodes: OutlineNode[],
): Promise<void> {
  let position = 0;
  for (const { node, ancestors } of walk(nodes)) {
    await tx.query(
      `INSERT INTO outline_nodes
         (outline_id, org_id, id, parent_id, position, name, level, printed_from, printed_to, kind, external_ref)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        outlineId,
        orgId,
        node.id,
        ancestors.at(-1)?.id ?? null,
        position++,
        node.name,
        node.level,
        node.printed_pages?.from ?? null,
        node.printed_pages?.to ?? null,
        node.kind,
        node.external_ref,
      ],
    );
  }
}

function buildTree(rows: NodeRow[]): OutlineNode[] {
  const roots: OutlineNode[] = [];
  const byId = new Map<string, OutlineNode>();
  for (const row of rows) {
    const node: OutlineNode = {
      id: row.id,
      name: row.name,
      level: row.level,
      printed_pages:
        row.printed_from === null || row.printed_to === null
          ? null
          : { from: row.printed_from, to: row.printed_to },
      kind: row.kind,
      external_ref: row.external_ref,
      children: [],
    };
    byId.set(row.id, node);
    const parent = row.parent_id === null ? undefined : byId.get(row.parent_id);
    (parent ? parent.children : roots).push(node);
  }
  return roots;
}
