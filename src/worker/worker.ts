import { PgBoss } from "pg-boss";
import type { DatabaseConfig } from "../shared/config.ts";
import { queues } from "../shared/queues.ts";

export interface Worker {
  boss: PgBoss;
  stop(): Promise<void>;
}

/** Connects pg-boss (creating its schema on first run) and starts draining every queue. */
export async function startWorker(config: DatabaseConfig): Promise<Worker> {
  const boss = new PgBoss(config.databaseUrl);
  boss.on("error", (error) => {
    console.error("pg-boss error", error);
  });
  await boss.start();

  await boss.createQueue(queues.noop);
  await boss.work(queues.noop, () => Promise.resolve());

  return {
    boss,
    stop: () => boss.stop({ graceful: true }),
  };
}
