// Outlines in Postgres: a row per outline and a row per node (spec #1 §6).
import type {
  Outline,
  OutlineDrafting,
  OutlineNode,
  OutlineStatus,
} from "../contract/outline.ts";
import type { BlobStore } from "../storage/store.ts";
import { addDays, type Clock } from "../shared/clock.ts";
import type { Db, Queryable } from "../shared/db/pool.ts";
import { newId } from "../shared/ids.ts";
import { Refusal } from "../shared/refusal.ts";
import { validateOutline, walk } from "./tree.ts";

/** A draft or unused confirmed outline expires after this many days (spec §3). */
export const OUTLINE_TTL_DAYS = 30;

/** Where an outline's syllabus is, as stored in `outlines.source`. */
export type SyllabusSource =
  | { type: "pdf"; upload_id: string; storage_key: string }
  | { type: "images"; upload_ids: string[]; storage_keys: string[] }
  | {
      type: "book_pages";
      upload_id: string;
      storage_key: string;
      from: number;
      to: number;
    };

/** How long the syllabus page links in an outline last. */
const SOURCE_URL_SECONDS = 60 * 60;

export interface StoredOutline {
  id: string;
  orgId: string;
  status: OutlineStatus;
  nodes: OutlineNode[];
  drafting: OutlineDrafting | null;
  /** The syllabus pages, in order, with their images once rendered. */
  sourcePages: { page: number; imageKey: string | null }[];
  createdAt: Date;
  expiresAt: Date;
}

interface OutlineRow {
  id: string;
  org_id: string;
  status: OutlineStatus;
  drafting: OutlineDrafting["status"] | null;
  created_at: Date;
  expires_at: Date;
}

interface PageRow {
  page: number;
  image_key: string | null;
  state: "pending" | "read" | "failed";
  failure: string | null;
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

export async function outlineView(
  store: BlobStore,
  outline: StoredOutline,
): Promise<Outline> {
  const { errors, warnings } = validateOutline(outline.nodes);
  const sourcePages = await Promise.all(
    outline.sourcePages.map(async ({ page, imageKey }) => ({
      page,
      image_url: imageKey
        ? await store.signedUrl(imageKey, SOURCE_URL_SECONDS)
        : null,
    })),
  );
  return {
    id: outline.id,
    object: "outline",
    status: outline.status,
    drafting: outline.drafting,
    source_pages: sourcePages,
    nodes: outline.nodes,
    errors,
    warnings,
    created_at: outline.createdAt.toISOString(),
    expires_at: outline.expiresAt.toISOString(),
  };
}

export interface NewOutline {
  orgId: string;
  apiKeyId: string;
  source: unknown;
  nodes: OutlineNode[];
  /** A syllabus to draft from: its page count. The tree starts empty. */
  syllabusPages?: number;
}

/**
 * Stores a new draft outline. With a syllabus, it starts drafting; `then`
 * runs in the same transaction (to queue the drafting job).
 */
export async function createOutline(
  db: Db,
  clock: Clock,
  outline: NewOutline,
  then?: (tx: Queryable, id: string) => Promise<void>,
): Promise<StoredOutline> {
  const id = newId("out");
  const now = clock();
  const drafting = outline.syllabusPages === undefined ? null : "running";
  await db.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO outlines (id, org_id, api_key_id, status, drafting, source, created_at, updated_at, expires_at)
       VALUES ($1, $2, $3, 'draft', $4, $5, $6, $6, $7)`,
      [
        id,
        outline.orgId,
        outline.apiKeyId,
        drafting,
        JSON.stringify(outline.source),
        now,
        addDays(now, OUTLINE_TTL_DAYS),
      ],
    );
    await writeNodes(tx, id, outline.orgId, outline.nodes);
    for (let page = 1; page <= (outline.syllabusPages ?? 0); page++) {
      await tx.query(
        "INSERT INTO outline_pages (outline_id, org_id, page) VALUES ($1, $2, $3)",
        [id, outline.orgId, page],
      );
    }
    await then?.(tx, id);
  });
  return mustGet(db, outline.orgId, id);
}

/** The organisation's outline, or null when it doesn't exist or belongs to someone else. */
export async function getOutline(
  db: Queryable,
  orgId: string,
  id: string,
): Promise<StoredOutline | null> {
  const { rows } = await db.query<OutlineRow>(
    "SELECT id, org_id, status, drafting, created_at, expires_at FROM outlines WHERE id = $1 AND org_id = $2",
    [id, orgId],
  );
  const row = rows[0];
  if (!row) return null;
  const nodes = await db.query<NodeRow>(
    `SELECT id, parent_id, name, level, printed_from, printed_to, kind, external_ref
     FROM outline_nodes WHERE outline_id = $1 ORDER BY position`,
    [id],
  );
  const pages = await db.query<PageRow>(
    "SELECT page, image_key, state, failure FROM outline_pages WHERE outline_id = $1 ORDER BY page",
    [id],
  );
  return {
    id: row.id,
    orgId: row.org_id,
    status: row.status,
    nodes: buildTree(nodes.rows),
    drafting: row.drafting && {
      status: row.drafting,
      pages: pages.rows.length,
      pages_read: pages.rows.filter((p) => p.state !== "pending").length,
      failures: pages.rows
        .filter((p) => p.state === "failed")
        .map((p) => ({ page: p.page, reason: p.failure ?? "unreadable" })),
    },
    sourcePages: pages.rows.map((p) => ({
      page: p.page,
      imageKey: p.image_key,
    })),
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

/** Locks the outline for a change; refused while its tree is still being drafted. */
async function lockStatus(
  tx: Queryable,
  orgId: string,
  id: string,
): Promise<OutlineStatus> {
  const { rows } = await tx.query<{
    status: OutlineStatus;
    drafting: string | null;
  }>(
    "SELECT status, drafting FROM outlines WHERE id = $1 AND org_id = $2 FOR UPDATE",
    [id, orgId],
  );
  const row = rows[0];
  if (!row) throw new Refusal("not_found", `No outline ${id}.`);
  if (row.drafting === "running") {
    throw new Refusal(
      "wrong_state",
      `Outline ${id} is still being drafted from its syllabus; try again when drafting is done.`,
    );
  }
  return row.status;
}

/**
 * Drafting's end: the drafted tree replaces the empty draft (nobody can edit
 * it while drafting runs). `failed` when no page could be read.
 */
export async function finishDrafting(
  db: Db,
  clock: Clock,
  id: string,
  nodes: OutlineNode[],
): Promise<void> {
  await db.transaction(async (tx) => {
    const { rows } = await tx.query<{
      org_id: string;
      drafting: string | null;
      read: number;
    }>(
      `SELECT org_id, drafting,
         (SELECT count(*)::int FROM outline_pages p WHERE p.outline_id = o.id AND p.state = 'read') AS read
       FROM outlines o WHERE id = $1 FOR UPDATE`,
      [id],
    );
    const row = rows[0];
    if (row?.drafting !== "running") return;
    await tx.query("DELETE FROM outline_nodes WHERE outline_id = $1", [id]);
    await writeNodes(tx, id, row.org_id, nodes);
    await tx.query(
      "UPDATE outlines SET drafting = $2, updated_at = $3 WHERE id = $1",
      [id, row.read > 0 ? "done" : "failed", clock()],
    );
  });
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
