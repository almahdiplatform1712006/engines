// `POST /v1/outlines` (spec §1 step 2): a tree that's sent is stored as the
// draft; a syllabus (pdf, photos or the book's contents pages) is checked,
// stored with an empty draft, and drafted by the worker.
import type { PgBoss } from "pg-boss";
import { balance } from "../accounts/credits.ts";
import type { Caller } from "../accounts/keys.ts";
import type { CreateOutlineRequest } from "../contract/outline.ts";
import { inTransaction, queues, type OutlineJob } from "../pipeline/deps.ts";
import { countStoredPdf } from "../render/count.ts";
import type { Clock } from "../shared/clock.ts";
import type { Db } from "../shared/db/pool.ts";
import { MAX_SYLLABUS_PAGES } from "../shared/limits.ts";
import { Refusal } from "../shared/refusal.ts";
import type { BlobStore } from "../storage/store.ts";
import { finishedUpload, PDF, type Upload } from "../uploads/uploads.ts";
import {
  createOutline,
  type StoredOutline,
  type SyllabusSource,
} from "./store.ts";
import { normaliseTree } from "./tree.ts";

export interface StartDeps {
  db: Db;
  boss: PgBoss;
  store: BlobStore;
  clock: Clock;
}

export async function startOutline(
  deps: StartDeps,
  caller: Caller,
  request: CreateOutlineRequest,
): Promise<StoredOutline> {
  const { source } = request;
  const base = { orgId: caller.orgId, apiKeyId: caller.apiKeyId };
  if (source.type === "manual") {
    return createOutline(deps.db, deps.clock, {
      ...base,
      source: { type: "manual" },
      nodes: normaliseTree(source.nodes),
    });
  }
  const { syllabus, pages } = await checkSyllabus(deps, caller.orgId, source);
  await checkDraftingRoom(deps.db, caller.orgId, pages);
  return createOutline(
    deps.db,
    deps.clock,
    { ...base, source: syllabus, nodes: [], syllabusPages: pages },
    async (tx, outlineId) => {
      await deps.boss.send(
        queues.draftOutline,
        { outlineId } satisfies OutlineJob,
        { db: inTransaction(tx) },
      );
    },
  );
}

/** Syllabus drafts one organisation may run at once. */
const MAX_DRAFTING = 3;

/**
 * Drafting reads each syllabus page with the model. It isn't billed, but it
 * needs credits to cover its pages and a free drafting slot, so a key can't
 * spend model calls without limit.
 */
async function checkDraftingRoom(
  db: Db,
  orgId: string,
  pages: number,
): Promise<void> {
  const available = await balance(db, orgId);
  if (available < pages) {
    throw new Refusal(
      "insufficient_credits",
      `Drafting reads ${String(pages)} syllabus pages and needs a balance that covers them; yours is ${String(available)} page credits.`,
      { details: { pages, balance: available } },
    );
  }
  const { rows } = await db.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM outlines WHERE org_id = $1 AND drafting = 'running'",
    [orgId],
  );
  if ((rows[0]?.n ?? 0) >= MAX_DRAFTING) {
    throw new Refusal(
      "too_many_jobs",
      `${String(MAX_DRAFTING)} syllabuses are already being drafted; try again when one is done.`,
      { retryAfter: 30 },
    );
  }
}

async function checkSyllabus(
  deps: StartDeps,
  orgId: string,
  source: Exclude<CreateOutlineRequest["source"], { type: "manual" }>,
): Promise<{ syllabus: SyllabusSource; pages: number }> {
  const upload = (id: string) =>
    finishedUpload(deps.db, deps.store, deps.clock, orgId, id);

  if (source.type === "images") {
    const photos: Upload[] = [];
    for (const id of source.upload_ids) {
      const photo = await upload(id);
      if (photo.contentType === PDF) {
        throw new Refusal(
          "invalid_request",
          "`images` takes photos, one page each. Send a PDF as `pdf`.",
        );
      }
      photos.push(photo);
    }
    return {
      syllabus: {
        type: "images",
        upload_ids: photos.map((p) => p.id),
        storage_keys: photos.map((p) => p.storageKey),
      },
      pages: photos.length,
    };
  }

  const pdf = await upload(source.upload_id);
  if (pdf.contentType !== PDF) {
    throw new Refusal(
      "invalid_request",
      `\`${source.type}\` takes a PDF. Send photos as \`images\`.`,
    );
  }
  const count = await countStoredPdf(deps.store, pdf.storageKey);
  if (source.type === "book_pages") {
    if (source.to > count) {
      throw new Refusal(
        "invalid_request",
        `The book has ${String(count)} pages; its contents pages can't run to page ${String(source.to)}.`,
      );
    }
    return {
      syllabus: {
        type: "book_pages",
        upload_id: pdf.id,
        storage_key: pdf.storageKey,
        from: source.from,
        to: source.to,
      },
      pages: source.to - source.from + 1,
    };
  }
  if (count > MAX_SYLLABUS_PAGES) {
    throw new Refusal(
      "too_large",
      `A syllabus is at most ${String(MAX_SYLLABUS_PAGES)} pages; this PDF has ${String(count)}. For a book, send only its contents pages as \`book_pages\`.`,
    );
  }
  return {
    syllabus: { type: "pdf", upload_id: pdf.id, storage_key: pdf.storageKey },
    pages: count,
  };
}
