// What every pipeline stage shares: queue names and options, dependencies,
// and running pg-boss sends inside our own transactions.
import type { PgBoss } from "pg-boss";
import type { PageReader } from "../reading/reader.ts";
import type { Clock } from "../shared/clock.ts";
import type { Provider } from "../shared/config.ts";
import type { Db, Queryable } from "../shared/db/pool.ts";
import type { BlobStore } from "../storage/store.ts";

export const queues = {
  render: "document.render",
  renderDead: "document.render.dead",
  readPage: "page.read",
  readPageDead: "page.read.dead",
  task: "document.task",
  taskDead: "document.task.dead",
  advance: "document.advance",
  advanceDead: "document.advance.dead",
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
  /** Page and follow-up tasks one worker runs at once. */
  pageConcurrency: number;
  /** Seconds before the first retry of a failed task (backoff doubles it). */
  retryDelay: number;
  /** Attempts per page (and per follow-up task) before it fails for good. */
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

export interface DocumentJob {
  documentId: string;
}
export interface PageJob {
  documentId: string;
  pdfPage: number;
}
export interface TaskJob {
  documentId: string;
  stage: "pair" | "solve";
  key: string;
}

/** pg-boss runs inside our transaction when handed one of these. */
export function inTransaction(tx: Queryable) {
  return {
    executeSql: (text: string, values?: unknown[]) => tx.query(text, values),
  };
}

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
  // One advance per document at a time: the queue holds one queued or active
  // job per singleton key.
  await boss.createQueue(queues.advance, {
    policy: "exclusive",
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
