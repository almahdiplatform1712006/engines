// Prepaid page credits (spec #1 §3 "billed per page", decision Q34; E-14).
//
// One credit is one page. The owner grants credits by hand. A document holds
// its page count when it's created (so two documents can't both spend the
// same credits), releases the hold when it ends, and writes exactly one
// usage entry: the pages it read.
import type { Queryable } from "../shared/db/pool.ts";
import { Refusal } from "../shared/refusal.ts";

export interface LedgerEntry {
  kind: "grant" | "hold" | "release" | "usage";
  pages: number;
  document_id: string | null;
  note: string | null;
  created_at: string;
}

export async function balance(db: Queryable, orgId: string): Promise<number> {
  const { rows } = await db.query<{ balance: number }>(
    "SELECT COALESCE(sum(pages), 0)::int AS balance FROM credit_ledger WHERE org_id = $1",
    [orgId],
  );
  return rows[0]?.balance ?? 0;
}

export async function grantCredits(
  db: Queryable,
  orgId: string,
  pages: number,
  note: string,
  createdBy: string | null = null,
): Promise<void> {
  if (!Number.isInteger(pages) || pages <= 0)
    throw new Error("a grant is a positive whole number of pages");
  await db.query(
    "INSERT INTO credit_ledger (org_id, kind, pages, note, created_by) VALUES ($1, 'grant', $2, $3, $4)",
    [orgId, pages, note, createdBy],
  );
}

/**
 * Holds `pages` credits for a document, or refuses with `402` naming the page
 * count and the balance. Runs in the create transaction, under an
 * organisation-wide lock so concurrent documents can't overdraw.
 */
export async function holdCredits(
  tx: Queryable,
  orgId: string,
  documentId: string,
  pages: number,
): Promise<void> {
  await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
    `credits:${orgId}`,
  ]);
  const available = await balance(tx, orgId);
  if (available < pages) {
    throw new Refusal(
      "insufficient_credits",
      `This book has ${String(pages)} pages and your balance is ${String(available)} page credits.`,
      { details: { pages, balance: available } },
    );
  }
  await tx.query(
    "INSERT INTO credit_ledger (org_id, kind, pages, document_id) VALUES ($1, 'hold', $2, $3) ON CONFLICT DO NOTHING",
    [orgId, -pages, documentId],
  );
}

/**
 * Ends a document's hold and bills it: releases what it held and writes one
 * usage entry for `billed` pages. Safe to repeat; runs in the transaction
 * that ends the document.
 */
export async function settleCredits(
  tx: Queryable,
  orgId: string,
  documentId: string,
  billed: number,
): Promise<void> {
  await tx.query(
    `INSERT INTO credit_ledger (org_id, kind, pages, document_id)
     SELECT org_id, 'release', -pages, document_id FROM credit_ledger
     WHERE document_id = $1 AND kind = 'hold'
     ON CONFLICT DO NOTHING`,
    [documentId],
  );
  await tx.query(
    "INSERT INTO credit_ledger (org_id, kind, pages, document_id) VALUES ($1, 'usage', $2, $3) ON CONFLICT DO NOTHING",
    [orgId, -billed, documentId],
  );
  await tx.query("UPDATE documents SET pages_billed = $2 WHERE id = $1", [
    documentId,
    billed,
  ]);
}

export async function ledger(
  db: Queryable,
  orgId: string,
  limit = 100,
): Promise<LedgerEntry[]> {
  const { rows } = await db.query<
    Omit<LedgerEntry, "created_at"> & { created_at: Date }
  >(
    `SELECT kind, pages, document_id, note, created_at FROM credit_ledger
     WHERE org_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2`,
    [orgId, limit],
  );
  return rows.map((r) => ({ ...r, created_at: r.created_at.toISOString() }));
}

/** A book whose page count isn't known yet still needs some credit to start. */
export async function requireSomeCredit(
  db: Queryable,
  orgId: string,
): Promise<void> {
  const available = await balance(db, orgId);
  if (available <= 0) {
    throw new Refusal(
      "insufficient_credits",
      `Your balance is ${String(available)} page credits.`,
      {
        details: { pages: null, balance: available },
      },
    );
  }
}
