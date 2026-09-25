import { createModelReader } from "../reading/model.ts";
import { recordCallsIn } from "../reading/log.ts";
import { languageModel } from "../reading/providers.ts";
import type { PageReader } from "../reading/reader.ts";
import { systemClock } from "../shared/clock.ts";
import {
  readAiConfig,
  readDatabaseConfig,
  readStorageConfig,
  readWorkerConfig,
  type Provider,
} from "../shared/config.ts";
import { connect } from "../shared/db/pool.ts";
import { storeFromConfig } from "../storage/from-config.ts";
import { startWorker } from "./worker.ts";

const { databaseUrl } = readDatabaseConfig(process.env);
const ai = readAiConfig(process.env);
const logDb = connect(databaseUrl, 2);
const record = recordCallsIn(logDb);

// One reader per provider, built on first use so a worker starts without keys
// and only fails the pages it can't read.
const readers = new Map<Provider, PageReader>();
const reader = (provider: Provider): PageReader => {
  let existing = readers.get(provider);
  if (!existing) {
    const { model, name } = languageModel(ai, provider, "main");
    existing = createModelReader({ model, modelName: name, record });
    readers.set(provider, existing);
  }
  return existing;
};

const worker = await startWorker({
  databaseUrl,
  store: storeFromConfig(readStorageConfig(process.env)),
  clock: systemClock,
  reader,
  options: readWorkerConfig(process.env),
});
console.log("worker started");

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    Promise.all([worker.stop(), logDb.close()]).then(
      () => process.exit(0),
      (error: unknown) => {
        console.error(error);
        process.exit(1);
      },
    );
  });
}
