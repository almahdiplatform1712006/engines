// The per-page steps drafting and scoring share. Each reports a failure for its
// page instead of throwing, so one bad page never stops a book (hard rule 5).
import { join } from "node:path";
import { bookPaths, exists, loadTruth } from "./book.ts";
import type { PageReader, PageReading } from "./reader.ts";
import type { ManifestPage, PageFailure, PageTruth } from "./truth.ts";

export type Outcome<T> =
  { ok: true; value: T } | { ok: false; failure: PageFailure };

/** The page's truth file, null when there is none yet, or `invalid_truth`. */
export async function truthFor(
  root: string,
  book: string,
  page: ManifestPage,
): Promise<Outcome<PageTruth | null>> {
  try {
    return { ok: true, value: await loadTruth(root, book, page.id) };
  } catch (error) {
    return failed(page, "invalid_truth", error);
  }
}

/** Runs the reader over the page image, or reports `image_missing` / `read_failed`. */
export async function readPage(
  root: string,
  book: string,
  page: ManifestPage,
  reader: PageReader,
): Promise<Outcome<PageReading>> {
  const image = join(bookPaths(root, book).images, page.image);
  if (!(await exists(image))) {
    return { ok: false, failure: { page: page.id, reason: "image_missing" } };
  }
  try {
    return {
      ok: true,
      value: await reader.read({ path: image, pdf_page: page.pdf_page }),
    };
  } catch (error) {
    return failed(page, "read_failed", error);
  }
}

function failed(
  page: ManifestPage,
  reason: PageFailure["reason"],
  error: unknown,
): { ok: false; failure: PageFailure } {
  return {
    ok: false,
    failure: { page: page.id, reason, detail: String(error) },
  };
}
