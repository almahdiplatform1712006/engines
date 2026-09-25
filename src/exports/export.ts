// `GET /v1/documents/{id}/export?format=json|xlsx|docx|pdf` (E-19). Always from
// the latest revision. Files are made on demand and cached in the results
// bucket under the revision number, so a new revision makes new files; they
// expire with the document.
import { hasEntitlement } from "../accounts/entitlements.ts";
import type { StoredImage } from "../assembly/result.ts";
import {
  documentView,
  latestResult,
  type DocumentRow,
} from "../documents/store.ts";
import { getOutline } from "../outline/store.ts";
import type { Queryable } from "../shared/db/pool.ts";
import { Refusal } from "../shared/refusal.ts";
import type { BlobStore } from "../storage/store.ts";
import { worksheetDocx } from "./docx.ts";
import { worksheetHtml } from "./html.ts";
import { htmlToPdf } from "./pdf.ts";
import { buildWorksheet, worksheetImages } from "./worksheet.ts";
import { resultXlsx } from "./xlsx.ts";

export const EXPORT_FORMATS = ["json", "xlsx", "docx", "pdf"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

const CONTENT_TYPES: Record<ExportFormat, string> = {
  json: "application/json",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pdf: "application/pdf",
};

export interface ExportDeps {
  db: Queryable;
  store: BlobStore;
  /** The Chromium binary for PDFs, found on first use. */
  chromium: () => Promise<string>;
}

export interface Exported {
  bytes: Buffer;
  contentType: string;
  filename: string;
}

export async function exportDocument(
  deps: ExportDeps,
  row: DocumentRow,
  format: ExportFormat,
): Promise<Exported> {
  if (row.status !== "completed" && row.status !== "completed_with_errors") {
    throw new Refusal(
      "wrong_state",
      `Document ${row.id} is ${row.status}; exports are ready once it completes.`,
    );
  }
  const title = await titleOf(deps.db, row);
  const filename = `${safeName(title)}.${format}`;
  const contentType = CONTENT_TYPES[format];

  // JSON is exactly what GET returns, signed URLs and all, so it isn't cached.
  if (format === "json") {
    const view = await documentView(deps.db, deps.store, row);
    return {
      bytes: Buffer.from(JSON.stringify(view, null, 2)),
      contentType,
      filename,
    };
  }

  const latest = await latestResult(deps.db, row.id);
  if (!latest)
    throw new Refusal("wrong_state", `Document ${row.id} has no result yet.`);
  const cacheKey = `results/${row.id}/exports/r${String(latest.number)}.${format}`;
  if ((await deps.store.size(cacheKey)) !== null) {
    return { bytes: await deps.store.get(cacheKey), contentType, filename };
  }

  const outline = await getOutline(deps.db, row.org_id, row.outline_id);
  const tree = outline?.nodes ?? [];
  const withExplanation =
    row.type !== "questions" &&
    (await hasEntitlement(deps.db, row.org_id, "explanation"));
  const worksheet = buildWorksheet({
    title,
    language: row.language,
    tree,
    result: latest.result,
    withExplanation,
  });

  let bytes: Buffer;
  if (format === "xlsx") {
    bytes = await resultXlsx({
      rtl: worksheet.rtl,
      tree,
      result: latest.result,
      withExplanation,
    });
  } else {
    const images = await loadImages(deps.store, worksheetImages(worksheet));
    bytes =
      format === "docx"
        ? await worksheetDocx(worksheet, images)
        : await htmlToPdf(
            await worksheetHtml(worksheet, images),
            await deps.chromium(),
          );
  }
  await deps.store.put(cacheKey, bytes, contentType);
  return { bytes, contentType, filename };
}

async function loadImages(
  store: BlobStore,
  images: readonly StoredImage[],
): Promise<Map<string, Buffer>> {
  const loaded = new Map<string, Buffer>();
  for (const image of images) {
    if (image.key && !loaded.has(image.key)) {
      try {
        loaded.set(image.key, await store.get(image.key));
      } catch {
        // A figure that's gone is left out of the sheet; the result still flags it.
      }
    }
  }
  return loaded;
}

/** The book's file name, else its outline's first node. */
async function titleOf(db: Queryable, row: DocumentRow): Promise<string> {
  const uploadId =
    row.source.kind === "pdf"
      ? row.source.upload_id
      : row.source.uploads[0]?.upload_id;
  const { rows } = await db.query<{ filename: string }>(
    "SELECT filename FROM uploads WHERE id = $1",
    [uploadId],
  );
  const filename = rows[0]?.filename.replace(/\.[^.]+$/, "");
  if (filename) return filename;
  const { rows: nodes } = await db.query<{ name: string }>(
    "SELECT name FROM outline_nodes WHERE outline_id = $1 ORDER BY position LIMIT 1",
    [row.outline_id],
  );
  return nodes[0]?.name ?? row.id;
}

// Characters no file system takes, and control characters (built, not
// written, so the pattern holds no control character itself).
const UNSAFE = new RegExp(
  `[\\\\/:*?"<>|${String.fromCharCode(0)}-${String.fromCharCode(0x1f)}]+`,
  "g",
);

function safeName(name: string): string {
  const cleaned = name
    .replace(UNSAFE, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return cleaned === "" ? "document" : cleaned;
}
