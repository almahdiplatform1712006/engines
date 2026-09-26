// What every pipeline stage shares: queue names and options, dependencies,
// and running pg-boss sends inside our own transactions.
import type { PgBoss } from "pg-boss";
import type { ChunkOptions } from "../assembly/chunks.ts";
import type { PageReader } from "../reading/reader.ts";
import type { Clock } from "../shared/clock.ts";
import type { Provider } from "../shared/config.ts";
import type { Db, Queryable } from "../shared/db/pool.ts";
import type { BlobStore } from "../storage/store.ts";
import { createWebhookQueue } from "../webhooks/deliver.ts";
import type { TargetPolicy } from "../webhooks/target.ts";

export const queues = {
  render: "document.render",
  renderDead: "document.render.dead",
  readPage: "page.read",
  readPageDead: "page.read.dead",
  task: "document.task",
  taskDead: "document.task.dead",
  advance: "document.advance",
  advanceDead: "document.advance.dead",
  draftOutline: "outline.draft",
  draftOutlineDead: "outline.draft.dead",
} as const;

export interface PipelineDeps {
  db: Db;
  boss: PgBoss;
  store: BlobStore;
  clock: Clock;
  /** The page reader for a key's provider. */
  reader(provider: Provider): PageReader;
  /** Explanation chunk sizes; the defaults when unset. */
  chunking?: ChunkOptions;
  webhooks: TargetPolicy;
}

export interface PipelineOptions {
  /** Page and follow-up tasks one worker runs at once. */
  pageConcurrency: number;
  /** Seconds before the first retry of a failed task (backoff doubles it). */
  retryDelay: number;
  /** Attempts per page (and per follow-up task) before it fails for good. */
  pageAttempts: number;
  /** How often an idle worker polls each queue. */
  pollingIntervalSeconds: number;
  /** Seconds before a failed webhook delivery is retried (backoff doubles it). */
  webhookRetryDelay: number;
  /** Page reads in flight across every worker at once: the global model-call cap. */
  globalPageReads: number;
}

export const DEFAULT_OPTIONS: PipelineOptions = {
  pageConcurrency: 4,
  retryDelay: 5,
  pageAttempts: 3,
  pollingIntervalSeconds: 2,
  webhookRetryDelay: 30,
  globalPageReads: 32,
};

/** Every page read joins one group, so pg-boss caps them across all workers. */
export const PAGE_READ_GROUP = { id: "model-calls" } as const;

export interface DocumentJob {
  documentId: string;
}
export interface PageJob {
  documentId: string;
  pdfPage: number;
}
export interface OutlineJob {
  outlineId: string;
}
export interface TaskJob {
  documentId: string;
  stage: "pair" | "solve";
  key: string;
}

import { inTransaction } from "../shared/db/boss.ts";

export { inTransaction };

/** Creates the queues. The API calls this too, since it sends jobs. */
export async function createQueues(
  boss: PgBoss,
  options: PipelineOptions = DEFAULT_OPTIONS,
): Promise<void> {
  for (const dead of [
    queues.renderDead,
    queues.readPageDead,
    queues.taskDead,
    queues.advanceDead,
    queues.draftOutlineDead,
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
  for (const [name, deadLetter] of [
    [queues.readPage, queues.readPageDead],
    [queues.task, queues.taskDead],
  ] as const) {
    await boss.createQueue(name, {
      retryLimit: options.pageAttempts - 1,
      retryDelay: options.retryDelay,
      retryBackoff: true,
      expireInSeconds: 600,
      deadLetter,
    });
  }
  await boss.createQueue(queues.draftOutline, {
    retryLimit: 2,
    retryDelay: options.retryDelay,
    retryBackoff: true,
    expireInSeconds: 1800,
    deadLetter: queues.draftOutlineDead,
  });
  await createWebhookQueue(boss, options.webhookRetryDelay);
  // One advance per document runs at a time, and one more may wait behind it
  // (`stately`: one job per state per singleton key). A task settling while
  // an advance is still active queues the next one instead of being dropped.
  await boss.createQueue(queues.advance, {
    policy: "stately",
    retryLimit: 3,
    retryDelay: options.retryDelay,
    retryBackoff: true,
    expireInSeconds: 1800,
    deadLetter: queues.advanceDead,
  });
}

/** Enqueues the next stage step, in the caller's transaction. */
export async function startAdvance(
  boss: PgBoss,
  tx: Queryable,
  documentId: string,
): Promise<void> {
  await boss.send(queues.advance, { documentId } satisfies DocumentJob, {
    singletonKey: documentId,
    db: inTransaction(tx),
  });
}

export async function providerOf(
  db: Queryable,
  apiKeyId: string,
): Promise<Provider> {
  const { rows } = await db.query<{ provider: Provider }>(
    "SELECT provider FROM api_keys WHERE id = $1",
    [apiKeyId],
  );
  return rows[0]?.provider ?? "openrouter";
}

export async function inBatches<T>(
  items: readonly T[],
  size: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  for (let i = 0; i < items.length; i += size) {
    await Promise.all(items.slice(i, i + size).map(work));
  }
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
