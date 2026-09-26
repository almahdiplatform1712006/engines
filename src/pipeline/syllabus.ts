// Drafting a tree from a syllabus (E-16, spec §1 step 2): render each
// syllabus page, read its contents entries (one model call per page), then
// nest them and infer ranges in plain code (`draftTree`). Resumable like the
// book's render: pages already rendered or read are not done again. A page
// that still can't be read when the job's retries run out is recorded as
// failed; the tree drafts from the rest.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { draftTree, type ContentsEntry } from "../outline/draft.ts";
import { finishDrafting, type SyllabusSource } from "../outline/store.ts";
import { normaliseTree } from "../outline/tree.ts";
import {
  normalisePhoto,
  renderPage,
  type RenderedPage,
} from "../render/render.ts";
import { inBatches, providerOf, type PipelineDeps } from "./deps.ts";

const READ_CONCURRENCY = 4;
/** Tries per syllabus page before it's recorded as failed. */
const READ_ATTEMPTS = 2;

interface OutlineRow {
  org_id: string;
  api_key_id: string;
  drafting: string | null;
  source: SyllabusSource;
}

interface PageRow {
  page: number;
  image_key: string | null;
  state: "pending" | "read" | "failed";
  entries: ContentsEntry[] | null;
}

export async function draftOutline(
  deps: PipelineDeps,
  outlineId: string,
): Promise<void> {
  const { rows } = await deps.db.query<OutlineRow>(
    "SELECT org_id, api_key_id, drafting, source FROM outlines WHERE id = $1",
    [outlineId],
  );
  const outline = rows[0];
  if (outline?.drafting !== "running") return;

  await renderSyllabus(deps, outlineId, outline.source);

  const pages = await syllabusPages(deps, outlineId);
  const reader = deps.reader(await providerOf(deps.db, outline.api_key_id));
  const context = { orgId: outline.org_id, documentId: null };
  await inBatches(
    pages.filter((p) => p.state === "pending"),
    READ_CONCURRENCY,
    async (page) => {
      if (!page.image_key)
        throw new Error(`syllabus page ${String(page.page)} has no image`);
      const bytes = await deps.store.get(page.image_key);
      let failure = "";
      for (let attempt = 1; attempt <= READ_ATTEMPTS; attempt++) {
        try {
          const entries = await reader.readContents(
            { pdfPage: page.page, bytes, mediaType: "image/png" },
            context,
          );
          await deps.db.query(
            `UPDATE outline_pages SET state = 'read', entries = $3, failure = NULL
             WHERE outline_id = $1 AND page = $2 AND state = 'pending'`,
            [outlineId, page.page, JSON.stringify(entries)],
          );
          return;
        } catch (error) {
          failure = error instanceof Error ? error.message : String(error);
        }
      }
      // Still pending: the job's own retries (with backoff) try it again, so
      // a short provider outage doesn't fail the syllabus.
      await deps.db.query(
        `UPDATE outline_pages SET failure = $3
         WHERE outline_id = $1 AND page = $2 AND state = 'pending'`,
        [outlineId, page.page, `the page could not be read: ${failure}`],
      );
    },
  );

  const unread = (await syllabusPages(deps, outlineId)).filter(
    (p) => p.state === "pending",
  );
  if (unread.length > 0) {
    throw new Error(
      `syllabus pages ${unread.map((p) => String(p.page)).join(", ")} not read yet`,
    );
  }
  await settle(deps, outlineId);
}

/** Drafting gave up (its job's retries ran out): every page not read counts as failed, with its last error. */
export async function draftingDied(
  deps: PipelineDeps,
  outlineId: string,
): Promise<void> {
  await deps.db.query(
    `UPDATE outline_pages SET state = 'failed',
       failure = COALESCE(failure, 'the syllabus could not be processed')
     WHERE outline_id = $1 AND state = 'pending'`,
    [outlineId],
  );
  await settle(deps, outlineId);
}

/** The tree from every page that was read, in syllabus order. */
async function settle(deps: PipelineDeps, outlineId: string): Promise<void> {
  const pages = await syllabusPages(deps, outlineId);
  const nodes = normaliseTree(
    draftTree(pages.map((p) => (p.state === "read" ? (p.entries ?? []) : []))),
  );
  await finishDrafting(deps.db, deps.clock, outlineId, nodes);
}

async function syllabusPages(
  deps: PipelineDeps,
  outlineId: string,
): Promise<PageRow[]> {
  const { rows } = await deps.db.query<PageRow>(
    "SELECT page, image_key, state, entries FROM outline_pages WHERE outline_id = $1 ORDER BY page",
    [outlineId],
  );
  return rows;
}

/** One PNG per syllabus page, under the outline's own prefix. */
async function renderSyllabus(
  deps: PipelineDeps,
  outlineId: string,
  source: SyllabusSource,
): Promise<void> {
  const todo = (await syllabusPages(deps, outlineId)).filter(
    (p) => p.image_key === null,
  );
  if (todo.length === 0) return;
  const store = async (page: number, rendered: RenderedPage) => {
    const key = `pages/outlines/${outlineId}/${String(page)}.png`;
    await deps.store.put(key, rendered.png, "image/png");
    await deps.db.query(
      "UPDATE outline_pages SET image_key = $3 WHERE outline_id = $1 AND page = $2",
      [outlineId, page, key],
    );
  };

  if (source.type === "images") {
    for (const { page } of todo) {
      const key = source.storage_keys[page - 1];
      if (key)
        await store(page, await normalisePhoto(await deps.store.get(key)));
    }
    return;
  }
  const dir = await mkdtemp(join(tmpdir(), "engines-syllabus-"));
  try {
    const file = join(dir, "syllabus.pdf");
    await writeFile(file, await deps.store.get(source.storage_key));
    // A book's contents pages start at `from`; a syllabus PDF at its first page.
    const first = source.type === "book_pages" ? source.from : 1;
    for (const { page } of todo) {
      await store(page, await renderPage(file, first + page - 1));
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
