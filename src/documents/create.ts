// `POST /v1/documents`: every check a new document passes before it is queued
// (spec #1 §3), then the insert and admission in one transaction.
import type { PgBoss } from "pg-boss";
import { requireEntitlement } from "../accounts/entitlements.ts";
import type { Caller } from "../accounts/keys.ts";
import type { CreateDocumentRequest } from "../contract/document.ts";
import { getOutline, markInUse } from "../outline/store.ts";
import { admit } from "../pipeline/pipeline.ts";
import { addDays, type Clock } from "../shared/clock.ts";
import type { Db } from "../shared/db/pool.ts";
import { newId } from "../shared/ids.ts";
import { Refusal } from "../shared/refusal.ts";
import type { BlobStore } from "../storage/store.ts";
import { claimUploads, finishedUpload, PDF } from "../uploads/uploads.ts";
import type { DocumentSource } from "./store.ts";

/** Results, page images and exports are kept this long (spec §1 step 8). */
export const DOCUMENT_TTL_DAYS = 30;

export interface CreateDeps {
  db: Db;
  boss: PgBoss;
  store: BlobStore;
  clock: Clock;
}

export interface Created {
  id: string;
  object: "document";
  status: string;
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
  const source = await resolveSource(deps, caller.orgId, request.source);
  const uploadIds =
    source.kind === "pdf"
      ? [source.upload_id]
      : source.uploads.map((u) => u.upload_id);

  const id = newId("doc");
  const now = clock();
  const status = await db.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO documents
         (id, org_id, api_key_id, outline_id, type, language, status, source, webhook_url, created_at, expires_at, offset_mode)
       VALUES ($1, $2, $3, $4, $5, $6, 'queued', $7, $8, $9, $10, $11)`,
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
      ],
    );
    await claimUploads(tx, id, uploadIds);
    await markInUse(tx, outline.id);
    await admit(deps.boss, tx, caller.apiKeyId);
    const { rows } = await tx.query<{ status: string }>(
      "SELECT status FROM documents WHERE id = $1",
      [id],
    );
    return rows[0]?.status ?? "queued";
  });
  return { id, object: "document", status };
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
