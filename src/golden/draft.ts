// Drafting: run the current page reader over a golden book's pages and write
// draft truth files for the owner to correct (spec decision Q30).
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { bookPaths, exists, loadManifest, loadTruth } from "./book.ts";
import type { PageReader } from "./reader.ts";
import type { PageTruth } from "./truth.ts";

export interface DraftOptions {
  root: string;
  book: string;
  reader: PageReader;
  /** Replace existing drafts. Corrected truth is never replaced. */
  force?: boolean;
}

export interface DraftReport {
  /** Pages given a new draft. */
  written: string[];
  /** Pages whose existing truth file was left alone. */
  kept: string[];
  /** Pages that could not be drafted, and why. */
  failures: {
    page: string;
    reason: "image_missing" | "read_failed";
    detail?: string;
  }[];
}

export async function draftBook({
  root,
  book,
  reader,
  force = false,
}: DraftOptions): Promise<DraftReport> {
  const manifest = await loadManifest(root, book);
  const paths = bookPaths(root, book);
  const report: DraftReport = { written: [], kept: [], failures: [] };

  await mkdir(paths.truthDir, { recursive: true });
  for (const page of manifest.pages) {
    const existing = await loadTruth(root, book, page.id);
    if (existing !== null && (existing.status === "corrected" || !force)) {
      report.kept.push(page.id);
      continue;
    }

    const image = join(paths.images, page.image);
    if (!(await exists(image))) {
      report.failures.push({ page: page.id, reason: "image_missing" });
      continue;
    }

    let truth: PageTruth;
    try {
      const { content } = await reader.read({
        path: image,
        pdf_page: page.pdf_page,
      });
      truth = { status: "draft", ...content, pdf_page: page.pdf_page };
    } catch (error) {
      report.failures.push({
        page: page.id,
        reason: "read_failed",
        detail: String(error),
      });
      continue;
    }
    await writeFile(
      paths.truth(page.id),
      `${JSON.stringify(truth, null, 2)}\n`,
    );
    report.written.push(page.id);
  }
  return report;
}
