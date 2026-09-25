// Uploads: a row per file and a resumable session straight to storage
// (spec #1 §3 `POST /v1/uploads`).
import { z } from "zod";
import { addDays, type Clock } from "../shared/clock.ts";
import type { Queryable } from "../shared/db/pool.ts";
import { newId } from "../shared/ids.ts";
import { MAX_UPLOAD_BYTES, UPLOAD_TTL_DAYS } from "../shared/limits.ts";
import { Refusal } from "../shared/refusal.ts";
import type { BlobStore } from "../storage/store.ts";

export const PDF = "application/pdf";
export const PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

export const CreateUploadRequest = z.object({
  filename: z.string().min(1).max(255),
  content_type: z.enum([PDF, ...PHOTO_TYPES]),
  size: z.int().positive(),
});
export type CreateUploadRequest = z.infer<typeof CreateUploadRequest>;

export interface Upload {
  id: string;
  orgId: string;
  storageKey: string;
  filename: string;
  contentType: string;
  size: number;
  expiresAt: Date;
}

export const UploadView = z.object({
  id: z.string(),
  object: z.literal("upload"),
  upload_url: z.string(),
  method: z.literal("PUT"),
  expires_at: z.string(),
});

export async function createUpload(
  db: Queryable,
  store: BlobStore,
  clock: Clock,
  orgId: string,
  request: CreateUploadRequest,
): Promise<z.infer<typeof UploadView>> {
  if (request.size > MAX_UPLOAD_BYTES) {
    throw new Refusal(
      "too_large",
      `Files can be up to 500 MB; this one is ${String(Math.ceil(request.size / 1024 / 1024))} MB.`,
    );
  }
  const id = newId("up");
  const storageKey = `uploads/${orgId}/${id}`;
  const url = await store.createUpload(
    storageKey,
    request.content_type,
    request.size,
  );
  const expiresAt = addDays(clock(), UPLOAD_TTL_DAYS);
  await db.query(
    `INSERT INTO uploads (id, org_id, storage_key, filename, content_type, size, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      id,
      orgId,
      storageKey,
      request.filename,
      request.content_type,
      request.size,
      expiresAt,
    ],
  );
  return {
    id,
    object: "upload",
    upload_url: url,
    method: "PUT",
    expires_at: expiresAt.toISOString(),
  };
}

/**
 * The organisation's upload, checked to be unexpired, not used by another
 * document (its file is deleted when that document ends) and finished in storage.
 */
export async function finishedUpload(
  db: Queryable,
  store: BlobStore,
  clock: Clock,
  orgId: string,
  id: string,
): Promise<Upload> {
  const { rows } = await db.query<{
    id: string;
    org_id: string;
    storage_key: string;
    filename: string;
    content_type: string;
    expires_at: Date;
    document_id: string | null;
  }>("SELECT * FROM uploads WHERE id = $1 AND org_id = $2", [id, orgId]);
  const row = rows[0];
  if (!row) throw new Refusal("not_found", `No upload ${id}.`);
  if (row.document_id !== null) {
    throw new Refusal(
      "wrong_state",
      `Upload ${id} was already used by document ${row.document_id}. Upload the file again to run it again.`,
    );
  }
  if (row.expires_at <= clock()) {
    throw new Refusal(
      "gone",
      `Upload ${id} has expired. Upload the file again.`,
    );
  }
  const stored = await store.size(row.storage_key);
  if (stored === null) {
    throw new Refusal("upload_incomplete", `Upload ${id} hasn't finished yet.`);
  }
  if (stored > MAX_UPLOAD_BYTES) {
    throw new Refusal("too_large", "Files can be up to 500 MB.");
  }
  return {
    id: row.id,
    orgId: row.org_id,
    storageKey: row.storage_key,
    filename: row.filename,
    contentType: row.content_type,
    size: stored,
    expiresAt: row.expires_at,
  };
}

/**
 * Marks uploads as used by a document, inside the caller's transaction. Refused
 * when another document claimed one first.
 */
export async function claimUploads(
  tx: Queryable,
  documentId: string,
  uploadIds: readonly string[],
): Promise<void> {
  const { rowCount } = await tx.query(
    "UPDATE uploads SET document_id = $1 WHERE id = ANY($2) AND document_id IS NULL",
    [documentId, [...new Set(uploadIds)]],
  );
  if (rowCount !== new Set(uploadIds).size) {
    throw new Refusal(
      "wrong_state",
      "An upload in this request is already used by another document.",
    );
  }
}
