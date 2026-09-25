// The document pipeline (spec #1 §4, ADR 0001): the stage machine that takes a
// document from `queued` to a finished result. Each step is a pg-boss queue.
//
//   admit ──► render + quick pass ──► awaiting_offset ──► page.read × pages
//         ──► advance: pair re-reads, model answers ──► finish
//
// Tasks settle once, counting the document down in the same transaction that
// records them; the one that reaches zero moves the document on. A task that
// crashes or runs out of retries reaches its dead-letter queue, whose handler
// settles it as failed, so a document never waits on a lost task.
import { advance, failDocument, runTask, taskDied } from "./advance.ts";
import {
  createQueues,
  DEFAULT_OPTIONS,
  queues,
  type DocumentJob,
  type PageJob,
  type PipelineDeps,
  type PipelineOptions,
  type TaskJob,
} from "./deps.ts";
import { readPage, settlePage } from "./read.ts";
import { render } from "./render.ts";
import { sweep, SWEEP_QUEUE } from "./sweep.ts";
import {
  deliverWebhook,
  WEBHOOK_QUEUE,
  type WebhookJob,
} from "../webhooks/deliver.ts";

export { admit } from "./admit.ts";
export { createQueues, DEFAULT_OPTIONS, queues } from "./deps.ts";
export type { PipelineDeps, PipelineOptions } from "./deps.ts";
export { confirmOffset } from "./offset.ts";

export async function registerPipeline(
  deps: PipelineDeps,
  options: PipelineOptions = DEFAULT_OPTIONS,
): Promise<void> {
  const { boss } = deps;
  await createQueues(boss, options);
  const poll = { pollingIntervalSeconds: options.pollingIntervalSeconds };
  const busy = { ...poll, localConcurrency: options.pageConcurrency };

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
  await boss.work<PageJob>(queues.readPage, busy, async ([job]) => {
    if (job) await readPage(deps, job.data);
  });
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
  await boss.work<TaskJob>(queues.task, busy, async ([job]) => {
    if (job) await runTask(deps, job.data);
  });
  await boss.work<TaskJob>(queues.taskDead, poll, async ([job]) => {
    if (job) await taskDied(deps, job.data);
  });
  await boss.work<DocumentJob>(queues.advance, poll, async ([job]) => {
    if (job) await advance(deps, job.data.documentId);
  });
  // The sweep runs every minute on whichever worker picks it up.
  await boss.createQueue(SWEEP_QUEUE, { policy: "singleton", retryLimit: 0 });
  await boss.schedule(SWEEP_QUEUE, "* * * * *");
  await boss.work(SWEEP_QUEUE, poll, async () => {
    await sweep(deps);
  });
  await boss.work<WebhookJob>(WEBHOOK_QUEUE, poll, async ([job]) => {
    if (job) await deliverWebhook(deps, job.data);
  });
  await boss.work<DocumentJob>(queues.advanceDead, poll, async ([job]) => {
    if (job)
      await failDocument(
        deps,
        job.data.documentId,
        "the result could not be assembled",
      );
  });
}
