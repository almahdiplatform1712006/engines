import { readDatabaseConfig } from "../shared/config.ts";
import { startWorker } from "./worker.ts";

const worker = await startWorker(readDatabaseConfig(process.env));
console.log("worker started");

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    worker.stop().then(
      () => process.exit(0),
      (error: unknown) => {
        console.error(error);
        process.exit(1);
      },
    );
  });
}
