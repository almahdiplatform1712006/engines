// A document's stored page images, as the reader and the crop step take them.
import type { PageImage } from "../reading/reader.ts";
import type { Queryable } from "../shared/db/pool.ts";
import type { BlobStore } from "../storage/store.ts";

export async function loadPageImage(
  deps: { db: Queryable; store: BlobStore },
  documentId: string,
  pdfPage: number,
): Promise<PageImage> {
  const { rows } = await deps.db.query<{ image_key: string }>(
    "SELECT image_key FROM pages WHERE document_id = $1 AND pdf_page = $2",
    [documentId, pdfPage],
  );
  const key = rows[0]?.image_key;
  if (!key)
    throw new Error(`page ${String(pdfPage)} of ${documentId} has no image`);
  return { pdfPage, bytes: await deps.store.get(key), mediaType: "image/png" };
}
