// Visits (E-21): another platform's person on Engines' page through a
// one-time link, scoped to one outline or one document of one organisation.
// Not a Better Auth session, which would open the whole organisation: a
// visit reaches only its outline (and the documents run on it) or its
// document, and never keys, the back office or other outlines.
import { randomBytes } from "node:crypto";
import { addDays, type Clock } from "../shared/clock.ts";
import type { Queryable } from "../shared/db/pool.ts";
import { newId } from "../shared/ids.ts";
import { Refusal } from "../shared/refusal.ts";
import { hashKey } from "./keys.ts";

/** How long a link can wait to be opened. */
export const LINK_TTL_MS = 10 * 60 * 1000;
/** How long a visit lasts once the link is opened. */
export const VISIT_TTL_MS = 8 * 60 * 60 * 1000;
export const VISIT_COOKIE = "engines_visit";

export interface Visit {
  orgId: string;
  apiKeyId: string;
  outlineId: string | null;
  documentId: string | null;
  returnUrl: string;
  /** Every document the visit runs reports here, whatever the page sends. */
  webhookUrl: string | null;
}

/** A new one-time link's token and expiry. The outline or document must be the organisation's. */
export async function createLink(
  db: Queryable,
  clock: Clock,
  link: Visit,
): Promise<{ token: string; expiresAt: Date }> {
  const [table, id] = link.outlineId
    ? ["outlines", link.outlineId]
    : ["documents", link.documentId ?? ""];
  const { rows } = await db.query(
    `SELECT 1 FROM ${table} WHERE id = $1 AND org_id = $2`,
    [id, link.orgId],
  );
  if (rows.length === 0)
    throw new Refusal("not_found", `No ${table.slice(0, -1)} ${id}.`);
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(clock().getTime() + LINK_TTL_MS);
  await db.query(
    `INSERT INTO visitor_links
       (id, org_id, api_key_id, outline_id, document_id, return_url, webhook_url, token_hash, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      newId("vis"),
      link.orgId,
      link.apiKeyId,
      link.outlineId,
      link.documentId,
      link.returnUrl,
      link.webhookUrl,
      hashKey(token),
      expiresAt,
    ],
  );
  return { token, expiresAt };
}

/**
 * Opens a link: once, before it expires. Returns the visit's cookie value
 * and where the page should go, or null for a used, expired or unknown link.
 */
export async function openLink(
  db: Queryable,
  clock: Clock,
  token: string,
): Promise<{ cookie: string; visit: Visit } | null> {
  const cookie = randomBytes(32).toString("base64url");
  const now = clock();
  const { rows } = await db.query<LinkRow>(
    `UPDATE visitor_links SET used_at = $2, visit_hash = $3, visit_expires_at = $4
     WHERE token_hash = $1 AND used_at IS NULL AND expires_at > $2
     RETURNING org_id, api_key_id, outline_id, document_id, return_url, webhook_url`,
    [
      hashKey(token),
      now,
      hashKey(cookie),
      new Date(now.getTime() + VISIT_TTL_MS),
    ],
  );
  const row = rows[0];
  return row ? { cookie, visit: toVisit(row) } : null;
}

/** The visit behind a cookie value, while it lasts and its key isn't revoked. */
export async function findVisit(
  db: Queryable,
  clock: Clock,
  cookie: string,
): Promise<Visit | null> {
  const { rows } = await db.query<LinkRow>(
    `SELECT l.org_id, l.api_key_id, l.outline_id, l.document_id, l.return_url, l.webhook_url
     FROM visitor_links l JOIN api_keys k ON k.id = l.api_key_id
     WHERE l.visit_hash = $1 AND l.visit_expires_at > $2 AND k.revoked_at IS NULL`,
    [hashKey(cookie), clock()],
  );
  const row = rows[0];
  return row ? toVisit(row) : null;
}

/** Links are kept for a day after they end, then removed by the sweep. */
export async function removeOldLinks(
  db: Queryable,
  clock: Clock,
): Promise<void> {
  await db.query(
    `DELETE FROM visitor_links
     WHERE COALESCE(visit_expires_at, expires_at) < $1`,
    [addDays(clock(), -1)],
  );
}

interface LinkRow {
  org_id: string;
  api_key_id: string;
  outline_id: string | null;
  document_id: string | null;
  return_url: string;
  webhook_url: string | null;
}

function toVisit(row: LinkRow): Visit {
  return {
    orgId: row.org_id,
    apiKeyId: row.api_key_id,
    outlineId: row.outline_id,
    documentId: row.document_id,
    returnUrl: row.return_url,
    webhookUrl: row.webhook_url,
  };
}

/**
 * Whether a visit may touch this outline or document: its own outline and
 * the documents run on it, or its own document and that document's outline.
 */
export async function visitReaches(
  db: Queryable,
  visit: Visit,
  target: { outlineId?: string; documentId?: string },
): Promise<boolean> {
  if (target.outlineId !== undefined) {
    if (visit.outlineId !== null) return target.outlineId === visit.outlineId;
    const { rows } = await db.query(
      "SELECT 1 FROM documents WHERE id = $1 AND outline_id = $2",
      [visit.documentId, target.outlineId],
    );
    return rows.length > 0;
  }
  if (target.documentId !== undefined) {
    if (visit.documentId !== null)
      return target.documentId === visit.documentId;
    const { rows } = await db.query(
      "SELECT 1 FROM documents WHERE id = $1 AND outline_id = $2 AND org_id = $3",
      [target.documentId, visit.outlineId, visit.orgId],
    );
    return rows.length > 0;
  }
  return false;
}
