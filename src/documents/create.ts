// `POST /v1/documents`: every check a new document passes before it is queued
// (spec #1 §3), then the insert and admission in one transaction.
import type { PgBoss } from "pg-boss";
import { holdCredits, requireSomeCredit } from "../accounts/credits.ts";
import { requireEntitlement } from "../accounts/entitlements.ts";
import { countPdfPages } from "../render/count.ts";
import type { Caller } from "../accounts/keys.ts";
import type { CreateDocumentRequest } from "../contract/document.ts";
import { getOutline, markInUse } from "../outline/store.ts";
import type { Warning } from "../contract/document.ts";
import { admit, checkQueueRoom } from "../pipeline/admit.ts";
import { checkWebhookUrl, type TargetPolicy } from "../webhooks/target.ts";
import { createHash } from "node:crypto";
import { addDays, DAY_MS, type Clock } from "../shared/clock.ts";
import type { Db } from "../shared/db/pool.ts";
import { newId } from "../shared/ids.ts";
import { Refusal } from "../shared/refusal.ts";
import type { BlobStore } from "../storage/store.ts";
import { claimUploads, finishedUpload, PDF } from "../uploads/uploads.ts";
import type { DocumentSource } from "./store.ts";

/** A book may be up to 800 pages (spec decision Q35). */
export const MAX_PAGES = 800;

/** Results, page images and exports are kept this long (spec §1 step 8). */
export const DOCUMENT_TTL_DAYS = 30;

export interface CreateDeps {
  db: Db;
  boss: PgBoss;
  store: BlobStore;
  clock: Clock;
  webhooks: TargetPolicy;
}

export interface Created {
  id: string;
  object: "document";
  status: string;
  /** Set when this exact file was processed before (spec decision Q18): a re-run is a new job. */
  warning: Warning | null;
}

export async function createDocument(
  deps: CreateDeps,
  caller: Caller,
  request: CreateDocumentRequest,
): Promise<Created> {
  const { db, clock } = deps;
  const outline = await getOutline(db, caller.orgId, request.outline_id);
  if (!outline)
    throw new Refusal("not_found", `No outline ${request.outline_id}.`);
  if (outline.status === "draft") {
    throw new Refusal(
      "outline_not_confirmed",
      "Confirm the outline before running a document against it.",
    );
  }

  if (request.type !== "questions") {
    await requireEntitlement(db, caller.orgId, "explanation");
  }
  if (request.webhook_url !== undefined)
    checkWebhookUrl(request.webhook_url, deps.webhooks);
  const source = await resolveSource(deps, caller.orgId, request.source);
  const pageCount = await countPages(deps.store, source);
  if (pageCount !== null && pageCount > MAX_PAGES) {
    throw new Refusal(
      "too_large",
      `Books can be up to ${String(MAX_PAGES)} pages; this one has ${String(pageCount)}.`,
    );
  }
  const fileHash = await fingerprintOf(deps.store, source);
  const warning =
    fileHash === null
      ? null
      : await sameFileWarning(db, clock, caller.orgId, fileHash);
  const uploadIds =
    source.kind === "pdf"
      ? [source.upload_id]
      : source.uploads.map((u) => u.upload_id);

  const id = newId("doc");
  const now = clock();
  const status = await db.transaction(async (tx) => {
    // 429 when the key's queue is full; holds the key's lock until commit.
    await checkQueueRoom(tx, caller.apiKeyId);
    await tx.query(
      `INSERT INTO documents
         (id, org_id, api_key_id, outline_id, type, language, status, source, webhook_url,
          created_at, expires_at, offset_mode, file_hash, warning)
       VALUES ($1, $2, $3, $4, $5, $6, 'queued', $7, $8, $9, $10, $11, $12, $13)`,
      [
        id,
        caller.orgId,
        caller.apiKeyId,
        outline.id,
        request.type,
        request.language ?? null,
        JSON.stringify(source),
        request.webhook_url ?? null,
        now,
        addDays(now, DOCUMENT_TTL_DAYS),
        request.offset ?? "confirm",
        fileHash,
        warning === null ? null : JSON.stringify(warning),
      ],
    );
    await claimUploads(tx, id, uploadIds);
    // 402 when the balance can't cover the book. A PDF pdf.js couldn't count
    // is held when rendering has counted it.
    if (pageCount !== null) await holdCredits(tx, caller.orgId, id, pageCount);
    else await requireSomeCredit(tx, caller.orgId);
    await markInUse(tx, outline.id);
    await admit(deps.boss, tx, caller.apiKeyId);
    const { rows } = await tx.query<{ status: string }>(
      "SELECT status FROM documents WHERE id = $1",
      [id],
    );
    return rows[0]?.status ?? "queued";
  });
  return { id, object: "document", status, warning };
}

async function resolveSource(
  deps: CreateDeps,
  orgId: string,
  source: CreateDocumentRequest["source"],
): Promise<DocumentSource> {
  if ("upload_id" in source) {
    const upload = await finishedUpload(
      deps.db,
      deps.store,
      deps.clock,
      orgId,
      source.upload_id,
    );
    if (upload.contentType !== PDF) {
      throw new Refusal(
        "unsupported_file",
        "`upload_id` takes a PDF. Send photos as `upload_ids`, in page order.",
      );
    }
    return {
      kind: "pdf",
      upload_id: upload.id,
      storage_key: upload.storageKey,
    };
  }
  const uploads = [];
  for (const id of source.upload_ids) {
    const upload = await finishedUpload(
      deps.db,
      deps.store,
      deps.clock,
      orgId,
      id,
    );
    if (upload.contentType === PDF) {
      throw new Refusal(
        "unsupported_file",
        "`upload_ids` takes photos, one page each. Send a PDF as `upload_id`.",
      );
    }
    uploads.push({ upload_id: upload.id, storage_key: upload.storageKey });
  }
  return { kind: "images", uploads };
}

/** The book's fingerprint: its file's, or every photo's in order. Null when storage has none. */
async function fingerprintOf(
  store: BlobStore,
  source: DocumentSource,
): Promise<string | null> {
  const keys =
    source.kind === "pdf"
      ? [source.storage_key]
      : source.uploads.map((u) => u.storage_key);
  const prints = await Promise.all(keys.map((key) => store.fingerprint(key)));
  if (prints.some((p) => p === null)) return null;
  return keys.length === 1
    ? (prints[0] ?? null)
    : createHash("sha256").update(prints.join("|")).digest("base64");
}

/** "You processed this exact file N days ago": the organisation's latest document of the same bytes. */
async function sameFileWarning(
  db: Db,
  clock: Clock,
  orgId: string,
  fileHash: string,
): Promise<Warning | null> {
  const { rows } = await db.query<{ id: string; created_at: Date }>(
    "SELECT id, created_at FROM documents WHERE org_id = $1 AND file_hash = $2 ORDER BY created_at DESC LIMIT 1",
    [orgId, fileHash],
  );
  const earlier = rows[0];
  if (!earlier) return null;
  const days = Math.floor(
    (clock().getTime() - earlier.created_at.getTime()) / DAY_MS,
  );
  return {
    code: "same_file_processed",
    message:
      days === 0
        ? "You processed this exact file earlier today. This is a new job."
        : `You processed this exact file ${String(days)} day${days === 1 ? "" : "s"} ago. This is a new job.`,
    document_id: earlier.id,
    processed_at: earlier.created_at.toISOString(),
  };
}

/** Pages in the book: photos one each, a PDF counted from storage. Null when unreadable. */
async function countPages(
  store: BlobStore,
  source: DocumentSource,
): Promise<number | null> {
  if (source.kind === "images") return source.uploads.length;
  const size = await store.size(source.storage_key);
  return size === null ? null : countPdfPages(store, source.storage_key, size);
}
