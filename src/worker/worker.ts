import { PgBoss } from "pg-boss";
import {
  DEFAULT_OPTIONS,
  registerPipeline,
  type PipelineDeps,
  type PipelineOptions,
} from "../pipeline/pipeline.ts";
import { connect } from "../shared/db/pool.ts";
import { queues } from "../shared/queues.ts";

export interface WorkerDeps extends Omit<PipelineDeps, "db" | "boss"> {
  databaseUrl: string;
  options?: Partial<PipelineOptions>;
}

export interface Worker {
  boss: PgBoss;
  deps: PipelineDeps;
  stop(): Promise<void>;
}

/** Connects pg-boss (creating its schema on first run) and starts draining every queue. */
export async function startWorker(deps: WorkerDeps): Promise<Worker> {
  const boss = new PgBoss(deps.databaseUrl);
  boss.on("error", (error) => {
    console.error("pg-boss error", error);
  });
  await boss.start();
  const db = connect(deps.databaseUrl);

  await boss.createQueue(queues.noop);
  await boss.work(queues.noop, () => Promise.resolve());

  const pipeline: PipelineDeps = {
    db,
    boss,
    store: deps.store,
    clock: deps.clock,
    reader: deps.reader,
  };
  await registerPipeline(pipeline, { ...DEFAULT_OPTIONS, ...deps.options });

  return {
    boss,
    deps: pipeline,
    async stop() {
      await boss.stop({ graceful: true });
      await db.close();
    },
  };
}
