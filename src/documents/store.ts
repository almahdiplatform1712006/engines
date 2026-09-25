// Documents in Postgres, and the `/v1/` view of one (spec #1 §3).
import type {
  Document,
  DocumentStatus,
  DocumentType,
  Failure,
  Warning,
} from "../contract/document.ts";
import type {
  ResultBody,
  StoredFailure,
  StoredImage,
} from "../assembly/result.ts";
import type { OffsetSegment } from "../offset/segments.ts";
import { hasEntitlement } from "../accounts/entitlements.ts";
import type { Queryable } from "../shared/db/pool.ts";
import { Refusal } from "../shared/refusal.ts";
import type { BlobStore } from "../storage/store.ts";

export type DocumentSource =
  | { kind: "pdf"; upload_id: string; storage_key: string }
  | { kind: "images"; uploads: { upload_id: string; storage_key: string }[] };

/** The storage keys of a document's book: the PDF, or every photo. */
export function sourceKeys(source: DocumentSource): string[] {
  return source.kind === "pdf"
    ? [source.storage_key]
    : source.uploads.map((u) => u.storage_key);
}

export interface DocumentRow {
  id: string;
  org_id: string;
  api_key_id: string;
  outline_id: string;
  type: DocumentType;
  language: string | null;
  status: DocumentStatus;
  source: DocumentSource;
  webhook_url: string | null;
  page_count: number | null;
  pages_pending: number;
  tasks_pending: number;
  stage: "read" | "pair" | "solve" | "finish";
  offset_segments: OffsetSegment[] | null;
  offset_mode: "confirm" | "auto";
  warning: Warning | null;
  offset_agreement: number | null;
  revision: number;
  error: string | null;
  pages_billed: number | null;
  expired_at: Date | null;
  created_at: Date;
  finished_at: Date | null;
  expires_at: Date;
}

/** Signed image URLs in a result live this long. */
export const IMAGE_URL_TTL_SECONDS = 24 * 3600;

export async function getDocumentRow(
  db: Queryable,
  orgId: string,
  id: string,
): Promise<DocumentRow | null> {
  const { rows } = await db.query<DocumentRow>(
    "SELECT * FROM documents WHERE id = $1 AND org_id = $2",
    [id, orgId],
  );
  return rows[0] ?? null;
}

/** The organisation's document, refused as `not_found` or, past its 30 days, `gone` (410). */
export async function liveDocument(
  db: Queryable,
  orgId: string,
  id: string,
): Promise<DocumentRow> {
  const row = await getDocumentRow(db, orgId, id);
  if (!row) throw new Refusal("not_found", `No document ${id}.`);
  if (row.expired_at !== null) {
    throw new Refusal(
      "gone",
      `Document ${id} expired on ${row.expired_at.toISOString()}; results are kept 30 days.`,
    );
  }
  return row;
}

/** Any organisation's document: for the worker, which acts on the document itself. */
export async function loadDocument(
  db: Queryable,
  id: string,
): Promise<DocumentRow> {
  const { rows } = await db.query<DocumentRow>(
    "SELECT * FROM documents WHERE id = $1",
    [id],
  );
  const row = rows[0];
  if (!row) throw new Error(`document ${id} not found`);
  return row;
}

export async function latestResult(
  db: Queryable,
  id: string,
): Promise<{ number: number; result: ResultBody } | null> {
  const { rows } = await db.query<{ number: number; result: ResultBody }>(
    "SELECT number, result FROM revisions WHERE document_id = $1 ORDER BY number DESC LIMIT 1",
    [id],
  );
  return rows[0] ?? null;
}

/** The `/v1/` document: status while running, the latest revision's result when done. */
export async function documentView(
  db: Queryable,
  store: BlobStore,
  row: DocumentRow,
): Promise<Document> {
  const [latest, progress] = await Promise.all([
    latestResult(db, row.id),
    db.query<{ read: number }>(
      "SELECT count(*)::int AS read FROM pages WHERE document_id = $1 AND state <> 'pending'",
      [row.id],
    ),
  ]);
  const body = latest?.result;
  const url = async (image: StoredImage | null) =>
    image?.key
      ? { url: await store.signedUrl(image.key, IMAGE_URL_TTL_SECONDS) }
      : null;

  const document: Document = {
    id: row.id,
    object: "document",
    type: row.type,
    status: row.status,
    revision: row.revision,
    outline_id: row.outline_id,
    created_at: row.created_at.toISOString(),
    expires_at: row.expires_at.toISOString(),
    progress: {
      pages_total: row.page_count,
      pages_read: progress.rows[0]?.read ?? 0,
    },
    usage: { pages: row.pages_billed ?? 0 },
    error: row.error,
    warning: row.warning,
    offset: row.offset_segments ?? [],
    offset_agreement: row.offset_agreement,
    stimuli: await Promise.all(
      (body?.stimuli ?? []).map(async (s) => ({
        ...s,
        image: await url(s.image),
      })),
    ),
    questions: await Promise.all(
      (body?.questions ?? []).map(async (q) => ({
        ...q,
        image: await url(q.image),
      })),
    ),
    skipped: body?.skipped ?? { neither: 0, off_type: 0 },
    failures: await withPageImages(db, store, row.id, body?.failures ?? []),
  };
  // Explanation is only returned while the organisation holds the entitlement.
  if (
    row.type !== "questions" &&
    (await hasEntitlement(db, row.org_id, "explanation"))
  ) {
    document.explanation = await Promise.all(
      (body?.explanation ?? []).map(async (chunk) => ({
        ...chunk,
        figures: (await Promise.all(chunk.figures.map(url))).filter(
          (f) => f !== null,
        ),
      })),
    );
  }
  return document;
}

/** Each failure with a signed URL to its page's image, where the page was rendered. */
async function withPageImages(
  db: Queryable,
  store: BlobStore,
  documentId: string,
  failures: readonly StoredFailure[],
): Promise<Failure[]> {
  if (failures.length === 0) return [];
  const { rows } = await db.query<{ pdf_page: number; image_key: string }>(
    "SELECT pdf_page, image_key FROM pages WHERE document_id = $1 AND pdf_page = ANY($2)",
    [documentId, [...new Set(failures.map((f) => f.locator.pdf_page))]],
  );
  const keys = new Map(rows.map((r) => [r.pdf_page, r.image_key]));
  return Promise.all(
    failures.map(async (failure) => {
      const key = keys.get(failure.locator.pdf_page);
      return {
        ...failure,
        page_image: key
          ? { url: await store.signedUrl(key, IMAGE_URL_TTL_SECONDS) }
          : null,
      };
    }),
  );
}
