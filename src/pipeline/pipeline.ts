// The document pipeline (spec #1 §4, ADR 0001): the stage machine that takes a
// document from `queued` to a finished result. Each stage is a pg-boss queue.
//
//   admit ──► render ──► page.read × pages ──► finish
//
// Page tasks settle through `settlePage`, which counts them down in the same
// transaction that records the page; the task that reaches zero starts finish.
// A task that crashes or runs out of retries reaches its dead-letter queue, whose
// handler settles it as failed, so a document never waits on a lost page.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PgBoss } from "pg-boss";
import { assemble, type FailedPage } from "../assembly/assemble.ts";
import type { OutlineNode } from "../contract/outline.ts";
import { loadDocument, type DocumentRow } from "../documents/store.ts";
import { IDENTITY } from "../offset/segments.ts";
import { getOutline } from "../outline/store.ts";
import type { PageReading } from "../reading/blocks.ts";
import type { PageReader } from "../reading/reader.ts";
import { normalisePhoto, pageCount, renderPage } from "../render/render.ts";
import type { Clock } from "../shared/clock.ts";
import type { Provider } from "../shared/config.ts";
import type { Db, Queryable } from "../shared/db/pool.ts";
import type { BlobStore } from "../storage/store.ts";

export const queues = {
  render: "document.render",
  renderDead: "document.render.dead",
  readPage: "page.read",
  readPageDead: "page.read.dead",
  finish: "document.finish",
  finishDead: "document.finish.dead",
} as const;

export interface PipelineDeps {
  db: Db;
  boss: PgBoss;
  store: BlobStore;
  clock: Clock;
  /** The page reader for a key's provider. */
  reader(provider: Provider): PageReader;
}

export interface PipelineOptions {
  /** Page tasks one worker runs at once. */
  pageConcurrency: number;
  /** Seconds before the first retry of a failed task (backoff doubles it). */
  retryDelay: number;
  /** Attempts per page before it becomes `part_failed`. */
  pageAttempts: number;
  /** How often an idle worker polls each queue. */
  pollingIntervalSeconds: number;
}

export const DEFAULT_OPTIONS: PipelineOptions = {
  pageConcurrency: 4,
  retryDelay: 5,
  pageAttempts: 3,
  pollingIntervalSeconds: 2,
};

interface DocumentJob {
  documentId: string;
}
interface PageJob {
  documentId: string;
  pdfPage: number;
}

/** pg-boss runs inside our transaction when handed one of these. */
export function inTransaction(tx: Queryable) {
  return {
    executeSql: (text: string, values?: unknown[]) => tx.query(text, values),
  };
}

/** Creates the queues. The API calls this too, since it sends render jobs. */
export async function createQueues(
  boss: PgBoss,
  options: PipelineOptions = DEFAULT_OPTIONS,
): Promise<void> {
  for (const dead of [
    queues.renderDead,
    queues.readPageDead,
    queues.finishDead,
  ]) {
    await boss.createQueue(dead, {
      retryLimit: 5,
      retryDelay: 10,
      retryBackoff: true,
    });
  }
  await boss.createQueue(queues.render, {
    retryLimit: 2,
    retryDelay: options.retryDelay,
    retryBackoff: true,
    expireInSeconds: 3600,
    deadLetter: queues.renderDead,
  });
  await boss.createQueue(queues.readPage, {
    retryLimit: options.pageAttempts - 1,
    retryDelay: options.retryDelay,
    retryBackoff: true,
    expireInSeconds: 600,
    deadLetter: queues.readPageDead,
  });
  await boss.createQueue(queues.finish, {
    policy: "exclusive",
    retryLimit: 3,
    retryDelay: options.retryDelay,
    retryBackoff: true,
    expireInSeconds: 1800,
    deadLetter: queues.finishDead,
  });
}

/**
 * Starts the key's queued documents. E-05 admits everything; E-13 adds the
 * per-key cap. Runs inside the caller's transaction.
 */
export async function admit(
  boss: PgBoss,
  tx: Queryable,
  apiKeyId: string,
): Promise<void> {
  const { rows } = await tx.query<{ id: string }>(
    `UPDATE documents SET status = 'rendering', started_at = now()
     WHERE id IN (
       SELECT id FROM documents WHERE api_key_id = $1 AND status = 'queued'
       ORDER BY created_at FOR UPDATE SKIP LOCKED
     )
     RETURNING id`,
    [apiKeyId],
  );
  for (const { id } of rows) {
    await boss.send(queues.render, { documentId: id } satisfies DocumentJob, {
      db: inTransaction(tx),
    });
  }
}

export async function registerPipeline(
  deps: PipelineDeps,
  options: PipelineOptions = DEFAULT_OPTIONS,
): Promise<void> {
  const { boss } = deps;
  await createQueues(boss, options);
  const poll = { pollingIntervalSeconds: options.pollingIntervalSeconds };

  await boss.work<DocumentJob>(queues.render, poll, async ([job]) => {
    if (job) await render(deps, job.data.documentId);
  });
  await boss.work<DocumentJob>(queues.renderDead, poll, async ([job]) => {
    if (job)
      await failDocument(
        deps,
        job.data.documentId,
        "the book could not be rendered",
      );
  });
  await boss.work<PageJob>(
    queues.readPage,
    { ...poll, localConcurrency: options.pageConcurrency },
    async ([job]) => {
      if (job) await readPage(deps, job.data);
    },
  );
  await boss.work<PageJob>(queues.readPageDead, poll, async ([job]) => {
    if (!job) return;
    const { rows } = await deps.db.query<{ error: string | null }>(
      "SELECT error FROM pages WHERE document_id = $1 AND pdf_page = $2",
      [job.data.documentId, job.data.pdfPage],
    );
    await settlePage(deps, job.data, {
      state: "failed",
      error: rows[0]?.error ?? "the page task stopped",
    });
  });
  await boss.work<DocumentJob>(queues.finish, poll, async ([job]) => {
    if (job) await finish(deps, job.data.documentId);
  });
  await boss.work<DocumentJob>(queues.finishDead, poll, async ([job]) => {
    if (job)
      await failDocument(
        deps,
        job.data.documentId,
        "the result could not be assembled",
      );
  });
}

/**
 * Step 1: one PNG per page, stored and reused by every later step. Resumable: a
 * retry skips pages already rendered, so a crash never renders a book twice.
 */
async function render(deps: PipelineDeps, documentId: string): Promise<void> {
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
    make: () => Promise<{ png: Buffer; width: number; height: number }>,
  ) => {
    if (done.has(pdfPage)) return;
    const page = await make();
    const key = `pages/${documentId}/${String(pdfPage)}.png`;
    await deps.store.put(key, page.png, "image/png");
    await deps.db.query(
      `INSERT INTO pages (document_id, org_id, pdf_page, image_key, width, height)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
      [documentId, doc.org_id, pdfPage, key, page.width, page.height],
    );
  };

  let count: number;
  if (doc.source.kind === "pdf") {
    const dir = await mkdtemp(join(tmpdir(), "engines-book-"));
    try {
      const file = join(dir, "book.pdf");
      await writeFile(file, await deps.store.get(doc.source.storage_key));
      count = await pageCount(file);
      for (let pdfPage = 1; pdfPage <= count; pdfPage++) {
        await addPage(pdfPage, () => renderPage(file, pdfPage));
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  } else {
    const photos = doc.source.uploads;
    count = photos.length;
    for (const [i, photo] of photos.entries()) {
      await addPage(i + 1, async () =>
        normalisePhoto(await deps.store.get(photo.storage_key)),
      );
    }
  }

  await deps.db.transaction(async (tx) => {
    const pending = await tx.query<{ pdf_page: number }>(
      "SELECT pdf_page FROM pages WHERE document_id = $1 AND state = 'pending' ORDER BY pdf_page",
      [documentId],
    );
    const moved = await tx.query(
      `UPDATE documents SET status = 'processing', page_count = $2, pages_pending = $3, offset_segments = $4
       WHERE id = $1 AND status = 'rendering'`,
      [documentId, count, pending.rows.length, JSON.stringify(IDENTITY)],
    );
    if (moved.rowCount !== 1) return;
    for (const { pdf_page } of pending.rows) {
      await deps.boss.send(
        queues.readPage,
        { documentId, pdfPage: pdf_page } satisfies PageJob,
        {
          db: inTransaction(tx),
        },
      );
    }
    if (pending.rows.length === 0) {
      await deps.boss.send(
        queues.finish,
        { documentId } satisfies DocumentJob,
        {
          singletonKey: documentId,
          db: inTransaction(tx),
        },
      );
    }
  });
}

/** Step 2: read one page, one image per call. A failure throws, so pg-boss retries this page alone. */
async function readPage(deps: PipelineDeps, job: PageJob): Promise<void> {
  const { rows } = await deps.db.query<{
    image_key: string;
    state: string;
    org_id: string;
    provider: Provider;
  }>(
    `UPDATE pages p SET attempts = attempts + 1
     FROM documents d JOIN api_keys k ON k.id = d.api_key_id
     WHERE p.document_id = $1 AND p.pdf_page = $2 AND d.id = p.document_id
     RETURNING p.image_key, p.state, p.org_id, k.provider`,
    [job.documentId, job.pdfPage],
  );
  const page = rows[0];
  if (page?.state !== "pending") return;

  let reading: PageReading;
  try {
    const bytes = await deps.store.get(page.image_key);
    reading = await deps
      .reader(page.provider)
      .readPage(
        { pdfPage: job.pdfPage, bytes, mediaType: "image/png" },
        { orgId: page.org_id, documentId: job.documentId },
      );
  } catch (error) {
    await deps.db.query(
      "UPDATE pages SET error = $3 WHERE document_id = $1 AND pdf_page = $2",
      [
        job.documentId,
        job.pdfPage,
        error instanceof Error ? error.message : String(error),
      ],
    );
    throw error;
  }
  await settlePage(deps, job, { state: "read", reading });
}

type PageOutcome =
  { state: "read"; reading: PageReading } | { state: "failed"; error: string };

/**
 * Records a page's outcome once (a redelivered task finds it settled and does
 * nothing) and counts the document's pending pages down in the same
 * transaction. Whoever settles the last page starts finish.
 */
export async function settlePage(
  deps: PipelineDeps,
  job: PageJob,
  outcome: PageOutcome,
): Promise<void> {
  await deps.db.transaction(async (tx) => {
    const settled = await tx.query(
      `UPDATE pages SET state = $3, reading = $4, printed_number = $5, error = $6
       WHERE document_id = $1 AND pdf_page = $2 AND state = 'pending'`,
      [
        job.documentId,
        job.pdfPage,
        outcome.state,
        outcome.state === "read" ? JSON.stringify(outcome.reading) : null,
        outcome.state === "read" ? outcome.reading.printed_number : null,
        outcome.state === "failed" ? outcome.error : null,
      ],
    );
    if (settled.rowCount !== 1) return;
    const { rows } = await tx.query<{ pages_pending: number }>(
      "UPDATE documents SET pages_pending = pages_pending - 1 WHERE id = $1 RETURNING pages_pending",
      [job.documentId],
    );
    if (rows[0]?.pages_pending === 0) {
      await deps.boss.send(
        queues.finish,
        { documentId: job.documentId } satisfies DocumentJob,
        {
          singletonKey: job.documentId,
          db: inTransaction(tx),
        },
      );
    }
  });
}

/** Steps 3–10: assemble the result from the stored readings and write revision 1. */
async function finish(deps: PipelineDeps, documentId: string): Promise<void> {
  const doc = await loadDocument(deps.db, documentId);
  if (doc.status !== "processing") return;

  const outline = await getOutline(deps.db, doc.org_id, doc.outline_id);
  if (!outline) throw new Error(`outline ${doc.outline_id} is missing`);
  const pages = await deps.db.query<{
    pdf_page: number;
    state: "pending" | "read" | "failed";
    reading: PageReading | null;
    error: string | null;
  }>(
    "SELECT pdf_page, state, reading, error FROM pages WHERE document_id = $1",
    [documentId],
  );

  const failedPages: FailedPage[] = pages.rows
    .filter((p) => p.state !== "read")
    .map((p) => ({ pdf_page: p.pdf_page, detail: p.error ?? "not read" }));
  const readings = pages.rows.flatMap((p) =>
    p.state === "read" && p.reading ? [p.reading] : [],
  );

  const result = assemble({
    type: doc.type,
    tree: outline.nodes satisfies OutlineNode[],
    segments: doc.offset_segments ?? IDENTITY,
    pages: readings,
    failedPages,
  });
  const status =
    result.failures.length > 0 ? "completed_with_errors" : "completed";

  await deps.db.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO revisions (document_id, org_id, number, result) VALUES ($1, $2, 1, $3)
       ON CONFLICT (document_id, number) DO NOTHING`,
      [documentId, doc.org_id, JSON.stringify(result)],
    );
    await tx.query(
      `UPDATE documents SET status = $2, revision = 1, finished_at = $3
       WHERE id = $1 AND status = 'processing'`,
      [documentId, status, deps.clock()],
    );
  });
  await deleteBook(deps, doc);
}

async function failDocument(
  deps: PipelineDeps,
  documentId: string,
  error: string,
): Promise<void> {
  const doc = await loadDocument(deps.db, documentId);
  const { rowCount } = await deps.db.query(
    `UPDATE documents SET status = 'failed', error = $2, finished_at = $3
     WHERE id = $1 AND status NOT IN ('completed', 'completed_with_errors', 'failed')`,
    [documentId, error, deps.clock()],
  );
  if (rowCount === 1) await deleteBook(deps, doc);
}

/** The book file is deleted when its job ends (spec §6). Page images stay for review. */
async function deleteBook(deps: PipelineDeps, doc: DocumentRow): Promise<void> {
  const keys =
    doc.source.kind === "pdf"
      ? [doc.source.storage_key]
      : doc.source.uploads.map((u) => u.storage_key);
  for (const key of keys) await deps.store.delete(key);
}
