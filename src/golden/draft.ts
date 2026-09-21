// Drafting: run the current page reader over a golden book's pages and write
// draft truth files for the owner to correct (spec decision Q30).
import { mkdir, writeFile } from "node:fs/promises";
import { bookPaths, loadManifest } from "./book.ts";
import { readPage, truthFor } from "./pages.ts";
import type { PageReader } from "./reader.ts";
import type { PageFailure, PageTruth } from "./truth.ts";

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
  failures: PageFailure[];
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
    const existing = await truthFor(root, book, page);
    if (!existing.ok) {
      report.failures.push(existing.failure);
      continue;
    }
    if (
      existing.value !== null &&
      (existing.value.status === "corrected" || !force)
    ) {
      report.kept.push(page.id);
      continue;
    }

    const reading = await readPage(root, book, page, reader);
    if (!reading.ok) {
      report.failures.push(reading.failure);
      continue;
    }
    const truth: PageTruth = {
      status: "draft",
      ...reading.value.content,
      pdf_page: page.pdf_page,
    };
    await writeFile(
      paths.truth(page.id),
      `${JSON.stringify(truth, null, 2)}\n`,
    );
    report.written.push(page.id);
  }
  return report;
}
