// Steps 1 and 1b: render every page, then the quick pass proposes the offset.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDocument, type DocumentRow } from "../documents/store.ts";
import {
  autoApprovable,
  fitSegments,
  samplePages,
  type Fit,
} from "../offset/fit.ts";
import { pageLabels } from "../render/labels.ts";
import {
  normalisePhoto,
  pageCount,
  renderPage,
  type RenderedPage,
} from "../render/render.ts";
import { parsePrintedNumber } from "../shared/text.ts";
import { inBatches, providerOf, type PipelineDeps } from "./deps.ts";
import { holdCredits } from "../accounts/credits.ts";
import { MAX_PAGES } from "../documents/create.ts";
import { Refusal } from "../shared/refusal.ts";
import { admit } from "./admit.ts";
import { failDocument } from "./advance.ts";

const QUICK_PASS_CONCURRENCY = 4;

/**
 * Step 1: one PNG per page, stored and reused by every later step. Resumable: a
 * retry skips pages already rendered, so a crash never renders a book twice.
 * Then step 1b, the quick pass, which proposes the offset.
 */
export async function render(
  deps: PipelineDeps,
  documentId: string,
): Promise<void> {
  const doc = await loadDocument(deps.db, documentId);
  if (doc.status !== "rendering") return;

  const done = new Set(
    (
      await deps.db.query<{ pdf_page: number }>(
        "SELECT pdf_page FROM pages WHERE document_id = $1",
        [documentId],
      )
    ).rows.map((r) => r.pdf_page),
  );
  const addPage = async (
    pdfPage: number,
    label: string | null,
    make: () => Promise<RenderedPage>,
  ) => {
    if (done.has(pdfPage)) return;
    const page = await make();
    const key = `pages/${documentId}/${String(pdfPage)}.png`;
    await deps.store.put(key, page.png, "image/png");
    await deps.db.query(
      `INSERT INTO pages (document_id, org_id, pdf_page, image_key, width, height, label)
       VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING`,
      [documentId, doc.org_id, pdfPage, key, page.width, page.height, label],
    );
  };

  let count: number;
  if (doc.source.kind === "pdf") {
    const dir = await mkdtemp(join(tmpdir(), "engines-book-"));
    try {
      const file = join(dir, "book.pdf");
      const bytes = await deps.store.get(doc.source.storage_key);
      await writeFile(file, bytes);
      count = await pageCount(file);
      if (!(await withinLimits(deps, doc, count))) return;
      const labels = await pageLabels(bytes);
      for (let pdfPage = 1; pdfPage <= count; pdfPage++) {
        await addPage(pdfPage, labels?.[pdfPage - 1] ?? null, () =>
          renderPage(file, pdfPage),
        );
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  } else {
    const photos = doc.source.uploads;
    count = photos.length;
    for (const [i, photo] of photos.entries()) {
      await addPage(i + 1, null, async () =>
        normalisePhoto(await deps.store.get(photo.storage_key)),
      );
    }
  }
  await deps.db.query("UPDATE documents SET page_count = $2 WHERE id = $1", [
    documentId,
    count,
  ]);

  const fit = await quickPass(deps, doc, count);
  await deps.db.transaction(async (tx) => {
    const auto = doc.offset_mode === "auto" && autoApprovable(fit);
    const segments = fit.segments.map((s) => ({ ...s, confirmed: auto }));
    // Waiting for a person releases the key's slot; an auto-approved offset is
    // confirmed now and takes the next free slot to start the full read.
    const moved = await tx.query(
      `UPDATE documents SET status = 'awaiting_offset', offset_segments = $2, offset_agreement = $3,
         offset_confirmed_at = CASE WHEN $4 THEN now() END
       WHERE id = $1 AND status = 'rendering'`,
      [documentId, JSON.stringify(segments), fit.agreement, auto],
    );
    if (moved.rowCount === 1) await admit(deps.boss, tx, doc.api_key_id);
  });
}

/**
 * Step 1b: read only the printed number on the sampled pages with the cheap
 * model, and fit the offset. Resumable like rendering: pages already read are
 * not read again. A page whose number can't be read counts as unnumbered.
 */
async function quickPass(
  deps: PipelineDeps,
  doc: DocumentRow,
  pageCount: number,
): Promise<Fit> {
  const sample = samplePages(pageCount);
  const { rows } = await deps.db.query<{
    pdf_page: number;
    image_key: string;
    quick_read: boolean;
  }>(
    `SELECT pdf_page, image_key, quick_read FROM pages
     WHERE document_id = $1 AND pdf_page = ANY($2)`,
    [doc.id, sample],
  );
  const reader = deps.reader(await providerOf(deps.db, doc.api_key_id));
  const todo = rows.filter((page) => !page.quick_read);
  await inBatches(todo, QUICK_PASS_CONCURRENCY, async (page) => {
    let raw: string | null = null;
    try {
      raw = await reader.readPrintedNumber(
        {
          pdfPage: page.pdf_page,
          bytes: await deps.store.get(page.image_key),
          mediaType: "image/png",
        },
        { orgId: doc.org_id, documentId: doc.id },
      );
    } catch (error) {
      console.error(`quick pass: page ${String(page.pdf_page)}`, error);
    }
    await deps.db.query(
      `UPDATE pages SET quick_read = true, quick_raw = $3, quick_number = $4
       WHERE document_id = $1 AND pdf_page = $2`,
      [doc.id, page.pdf_page, raw, parsePrintedNumber(raw)],
    );
  });

  // The quick reads, plus the PDF's own labels on the pages not sampled.
  const evidence = await deps.db.query<{
    pdf_page: number;
    quick_read: boolean;
    quick_number: number | null;
    label: string | null;
  }>(
    "SELECT pdf_page, quick_read, quick_number, label FROM pages WHERE document_id = $1",
    [doc.id],
  );
  return fitSegments(
    evidence.rows.flatMap((page) => {
      if (page.quick_read) {
        return [{ pdf_page: page.pdf_page, printed: page.quick_number }];
      }
      const labelled = parsePrintedNumber(page.label);
      return labelled === null
        ? []
        : [{ pdf_page: page.pdf_page, printed: labelled }];
    }),
  );
}

/**
 * poppler's page count against the limits (E-14): over 800 pages fails the
 * document, and a book pdf.js couldn't count at creation is held now, or
 * fails for want of credits. False when the document failed.
 */
async function withinLimits(
  deps: PipelineDeps,
  doc: DocumentRow,
  count: number,
): Promise<boolean> {
  if (count > MAX_PAGES) {
    await failDocument(
      deps,
      doc.id,
      `too_large: the book has ${String(count)} pages; the limit is ${String(MAX_PAGES)}`,
    );
    return false;
  }
  const held = await deps.db.query(
    "SELECT 1 FROM credit_ledger WHERE document_id = $1 AND kind = 'hold'",
    [doc.id],
  );
  if (held.rows.length > 0) return true;
  try {
    await deps.db.transaction((tx) =>
      holdCredits(tx, doc.org_id, doc.id, count),
    );
    return true;
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    await failDocument(deps, doc.id, `${error.code}: ${error.message}`);
    return false;
  }
}
