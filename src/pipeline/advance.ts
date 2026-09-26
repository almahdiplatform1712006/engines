// After the page reads: the follow-up stages and the finish (spec #1 §4 steps
// 3–10, ADR 0001).
//
//   read ──► pair (E-09: one task per page pair to re-read) ──► solve (E-11)
//        ──► finish: assemble, write revision 1, end the job
//
// `advance` runs whenever a stage's last task settles. It works out the next
// stage's tasks from what is stored; a stage with no tasks is passed straight
// through. Each task settles once and counts the document down, like pages.
import {
  assemble,
  type AssemblyInput,
  type FailedPage,
} from "../assembly/assemble.ts";
import { settleCredits } from "../accounts/credits.ts";
import type { Queryable } from "../shared/db/pool.ts";
import { enqueueWebhook } from "../webhooks/deliver.ts";
import { admitNext } from "./admit.ts";
import { cutCrops } from "./crops.ts";
import type { Join } from "../assembly/continuations.ts";
import { findPairs, type Pair } from "../assembly/continuations.ts";
import { cropImage } from "../render/crop.ts";
import { loadPageImage } from "./pages.ts";
import {
  loadDocument,
  sourceKeys,
  type DocumentRow,
} from "../documents/store.ts";
import { IDENTITY } from "../offset/segments.ts";
import { getOutline } from "../outline/store.ts";
import type { Block, PageReading } from "../reading/blocks.ts";
import { NoJoinedBlockError, TruncatedOutputError } from "../reading/model.ts";
import type { SolveRequest, SolvedAnswer } from "../reading/reader.ts";
import {
  inTransaction,
  messageOf,
  providerOf,
  queues,
  startAdvance,
  type PipelineDeps,
  type TaskJob,
} from "./deps.ts";

type Stage = TaskJob["stage"];

interface StoredInputs {
  readings: PageReading[];
  failedPages: FailedPage[];
  joins: Join[];
  solved: Map<string, SolvedAnswer>;
}

export async function advance(
  deps: PipelineDeps,
  documentId: string,
): Promise<void> {
  const doc = await loadDocument(deps.db, documentId);
  if (
    doc.status !== "processing" ||
    doc.pages_pending > 0 ||
    doc.tasks_pending > 0
  )
    return;
  const inputs = await storedInputs(deps, doc);

  let stage = doc.stage;
  if (stage === "read") {
    // Step 4: re-read only the page pairs a block runs across.
    const { pairs } = findPairs(inputs.readings);
    const tasks = pairs.map((pair) => ({
      key: pair.first.id,
      input: { first: pair.first, second: pair.second },
    }));
    if (await fanOut(deps, doc, "pair", tasks)) return;
    stage = "pair";
  }
  if (stage === "pair") {
    // Step 7: questions with no book or marked answer are solved by the model.
    const { unanswered } = assemble(await assemblyInput(deps, doc, inputs));
    const tasks = unanswered.map((question) => ({
      key: question.question_id,
      input: question,
    }));
    if (await fanOut(deps, doc, "solve", tasks)) return;
  }
  await finish(deps, doc, inputs);
}

/**
 * Starts a stage's tasks. False when it has none, so the caller moves on: the
 * stage is recorded either way, so a retried advance resumes after it.
 */
async function fanOut(
  deps: PipelineDeps,
  doc: DocumentRow,
  stage: Stage,
  tasks: readonly { key: string; input: unknown }[],
): Promise<boolean> {
  return deps.db.transaction(async (tx) => {
    if (tasks.length === 0) {
      await tx.query("UPDATE documents SET stage = $2 WHERE id = $1", [
        doc.id,
        stage,
      ]);
      return false;
    }
    for (const task of tasks) {
      await tx.query(
        `INSERT INTO tasks (document_id, org_id, stage, key, input) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT DO NOTHING`,
        [doc.id, doc.org_id, stage, task.key, JSON.stringify(task.input)],
      );
    }
    const pending = await tx.query<{ key: string }>(
      "SELECT key FROM tasks WHERE document_id = $1 AND stage = $2 AND state = 'pending'",
      [doc.id, stage],
    );
    await tx.query(
      "UPDATE documents SET stage = $2, tasks_pending = $3 WHERE id = $1",
      [doc.id, stage, pending.rows.length],
    );
    for (const { key } of pending.rows) {
      await deps.boss.send(
        queues.task,
        { documentId: doc.id, stage, key } satisfies TaskJob,
        {
          db: inTransaction(tx),
        },
      );
    }
    if (pending.rows.length === 0) await startAdvance(deps.boss, tx, doc.id);
    return true;
  });
}

/** Runs one follow-up task. A failure throws, so pg-boss retries this task alone. */
export async function runTask(deps: PipelineDeps, job: TaskJob): Promise<void> {
  const { rows } = await deps.db.query<{ state: string; input: unknown }>(
    `UPDATE tasks SET attempts = attempts + 1
     WHERE document_id = $1 AND stage = $2 AND key = $3
     RETURNING state, input`,
    [job.documentId, job.stage, job.key],
  );
  const task = rows[0];
  if (task?.state !== "pending") return;
  const doc = await loadDocument(deps.db, job.documentId);
  const reader = deps.reader(await providerOf(deps.db, doc.api_key_id));
  const context = { orgId: doc.org_id, documentId: doc.id };

  let output: unknown;
  try {
    if (job.stage === "solve") {
      const question = task.input as SolveRequest;
      // A question with a figure is solved with the figure's crop in view.
      const figure = question.figure
        ? {
            pdfPage: question.figure.pdf_page,
            bytes: await cropImage(
              Buffer.from(
                (await loadPageImage(deps, doc.id, question.figure.pdf_page))
                  .bytes,
              ),
              question.figure.box,
            ),
            mediaType: "image/png" as const,
          }
        : undefined;
      output = await reader.solve(question, context, figure);
    } else {
      const { first, second } = task.input as Pair;
      output = await reader.readPair(
        [
          await loadPageImage(deps, doc.id, first.pdf_page),
          await loadPageImage(deps, doc.id, second.pdf_page),
        ],
        [first, second],
        context,
      );
    }
  } catch (error) {
    // Output that never fits, or a join the model didn't return, won't change on a retry.
    if (
      error instanceof TruncatedOutputError ||
      error instanceof NoJoinedBlockError
    ) {
      await settleTask(deps, job, { state: "failed", error: messageOf(error) });
      return;
    }
    await deps.db.query(
      "UPDATE tasks SET error = $4 WHERE document_id = $1 AND stage = $2 AND key = $3",
      [job.documentId, job.stage, job.key, messageOf(error)],
    );
    throw error;
  }
  await settleTask(deps, job, { state: "done", output });
}

/** A task past its last retry (or lost): settled as failed, from its dead-letter queue. */
export async function taskDied(
  deps: PipelineDeps,
  job: TaskJob,
): Promise<void> {
  const { rows } = await deps.db.query<{ error: string | null }>(
    "SELECT error FROM tasks WHERE document_id = $1 AND stage = $2 AND key = $3",
    [job.documentId, job.stage, job.key],
  );
  await settleTask(deps, job, {
    state: "failed",
    error: rows[0]?.error ?? "the task stopped",
  });
}

type TaskOutcome =
  { state: "done"; output: unknown } | { state: "failed"; error: string };

async function settleTask(
  deps: PipelineDeps,
  job: TaskJob,
  outcome: TaskOutcome,
): Promise<void> {
  await deps.db.transaction(async (tx) => {
    const settled = await tx.query(
      `UPDATE tasks SET state = $4, output = $5, error = $6
       WHERE document_id = $1 AND stage = $2 AND key = $3 AND state = 'pending'`,
      [
        job.documentId,
        job.stage,
        job.key,
        outcome.state,
        outcome.state === "done" ? JSON.stringify(outcome.output) : null,
        outcome.state === "failed" ? outcome.error : null,
      ],
    );
    if (settled.rowCount !== 1) return;
    const { rows } = await tx.query<{ tasks_pending: number }>(
      "UPDATE documents SET tasks_pending = tasks_pending - 1 WHERE id = $1 RETURNING tasks_pending",
      [job.documentId],
    );
    if (rows[0]?.tasks_pending === 0)
      await startAdvance(deps.boss, tx, job.documentId);
  });
}

async function storedInputs(
  deps: PipelineDeps,
  doc: DocumentRow,
): Promise<StoredInputs> {
  const pages = await deps.db.query<{
    pdf_page: number;
    state: "pending" | "read" | "failed";
    reading: PageReading | null;
    error: string | null;
  }>(
    "SELECT pdf_page, state, reading, error FROM pages WHERE document_id = $1",
    [doc.id],
  );
  const tasks = await deps.db.query<{
    stage: Stage;
    key: string;
    state: "pending" | "done" | "failed";
    input: unknown;
    output: unknown;
  }>(
    "SELECT stage, key, state, input, output FROM tasks WHERE document_id = $1",
    [doc.id],
  );
  const done = (stage: Stage) =>
    tasks.rows.filter(
      (t) => t.stage === stage && t.state === "done" && t.output,
    );

  return {
    readings: pages.rows.flatMap((p) =>
      p.state === "read" && p.reading ? [p.reading] : [],
    ),
    failedPages: pages.rows
      .filter((p) => p.state !== "read")
      .map((p) => ({ pdf_page: p.pdf_page, detail: p.error ?? "not read" })),
    joins: done("pair").map((t) => {
      const { first, second } = t.input as Pair;
      return {
        replaces: [first.id, second.id] as const,
        block: t.output as Block,
      };
    }),
    solved: new Map(
      done("solve").map((t) => [t.key, t.output as SolvedAnswer]),
    ),
  };
}

async function assemblyInput(
  deps: PipelineDeps,
  doc: DocumentRow,
  inputs: StoredInputs,
): Promise<AssemblyInput> {
  const outline = await getOutline(deps.db, doc.org_id, doc.outline_id);
  if (!outline) throw new Error(`outline ${doc.outline_id} is missing`);
  return {
    type: doc.type,
    tree: outline.nodes,
    segments: doc.offset_segments ?? IDENTITY,
    pages: inputs.readings,
    failedPages: inputs.failedPages,
    joins: inputs.joins,
    ...(deps.chunking ? { chunking: deps.chunking } : {}),
  };
}

/** Steps 3–10: assemble the result from what is stored, and write revision 1. */
async function finish(
  deps: PipelineDeps,
  doc: DocumentRow,
  inputs: StoredInputs,
): Promise<void> {
  const { result } = assemble({
    ...(await assemblyInput(deps, doc, inputs)),
    solved: inputs.solved,
  });
  await cutCrops(deps, doc.id, result);
  const status =
    result.failures.length > 0 ? "completed_with_errors" : "completed";

  const ended = await deps.db.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO revisions (document_id, org_id, number, result) VALUES ($1, $2, 1, $3)
       ON CONFLICT (document_id, number) DO NOTHING`,
      [doc.id, doc.org_id, JSON.stringify(result)],
    );
    const moved = await tx.query(
      `UPDATE documents SET status = $2, stage = 'finish', revision = 1, finished_at = $3
       WHERE id = $1 AND status = 'processing'`,
      [doc.id, status, deps.clock()],
    );
    if (moved.rowCount !== 1) return false;
    await settleCredits(tx, doc.org_id, doc.id, await pagesRead(tx, doc.id));
    await enqueueWebhook(deps.boss, tx, {
      documentId: doc.id,
      status,
      revision: 1,
    });
    return true;
  });
  if (ended) await afterEnd(deps, doc);
}

export async function failDocument(
  deps: PipelineDeps,
  documentId: string,
  error: string,
): Promise<void> {
  const doc = await loadDocument(deps.db, documentId);
  const ended = await deps.db.transaction(async (tx) => {
    const moved = await tx.query(
      `UPDATE documents SET status = 'failed', error = $2, finished_at = $3
       WHERE id = $1 AND status NOT IN ('completed', 'completed_with_errors', 'failed')`,
      [documentId, error, deps.clock()],
    );
    if (moved.rowCount !== 1) return false;
    await settleCredits(
      tx,
      doc.org_id,
      documentId,
      await pagesRead(tx, documentId),
    );
    await enqueueWebhook(deps.boss, tx, {
      documentId,
      status: "failed",
      revision: doc.revision,
    });
    return true;
  });
  if (ended) await afterEnd(deps, doc);
}

/**
 * After a job ends: the book file is deleted (spec §6; page images stay for
 * review), and the key's slot goes to its next waiting document.
 */
async function afterEnd(deps: PipelineDeps, doc: DocumentRow): Promise<void> {
  for (const key of sourceKeys(doc.source)) await deps.store.delete(key);
  await admitNext(deps, doc.api_key_id);
}

/** A document is billed for the pages it read, not those that failed. */
async function pagesRead(tx: Queryable, documentId: string): Promise<number> {
  const { rows } = await tx.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM pages WHERE document_id = $1 AND state = 'read'",
    [documentId],
  );
  return rows[0]?.n ?? 0;
}
