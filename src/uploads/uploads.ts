// Uploads: a row per file and a resumable session straight to storage
// (spec #1 §3 `POST /v1/uploads`).
import { z } from "zod";
import { addDays, type Clock } from "../shared/clock.ts";
import type { Queryable } from "../shared/db/pool.ts";
import { newId } from "../shared/ids.ts";
import { Refusal } from "../shared/refusal.ts";
import type { BlobStore } from "../storage/store.ts";

/** A book may be up to 500 MB (spec decision Q35). */
export const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;
/** Unused uploads are deleted after 2 days, like the bucket's lifecycle rule. */
export const UPLOAD_TTL_DAYS = 2;

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

/** The organisation's upload, checked to be finished in storage. */
export async function finishedUpload(
  db: Queryable,
  store: BlobStore,
  orgId: string,
  id: string,
): Promise<Upload> {
  const { rows } = await db.query<{
    id: string;
    org_id: string;
    storage_key: string;
    filename: string;
    content_type: string;
    size: number;
    expires_at: Date;
  }>("SELECT * FROM uploads WHERE id = $1 AND org_id = $2", [id, orgId]);
  const row = rows[0];
  if (!row) throw new Refusal("not_found", `No upload ${id}.`);
  const stored = await store.size(row.storage_key);
  if (stored === null)
    throw new Refusal("upload_incomplete", `Upload ${id} hasn't finished yet.`);
  if (stored > MAX_UPLOAD_BYTES)
    throw new Refusal("too_large", "Files can be up to 500 MB.");
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
