import { serve } from "@hono/node-server";
import { PgBoss } from "pg-boss";
import { createQueues } from "../pipeline/pipeline.ts";
import { systemClock } from "../shared/clock.ts";
import {
  readApiConfig,
  readAuthConfig,
  readDatabaseConfig,
  readStorageConfig,
  readExportConfig,
  readWebhookPolicy,
} from "../shared/config.ts";
import { connect } from "../shared/db/pool.ts";
import { storeFromConfig } from "../storage/from-config.ts";
import { existsSync } from "node:fs";
import { createAuth } from "../accounts/auth.ts";
import { createApp } from "./app.ts";

// The page, built by `npm run build:web`.
const WEB_DIR = "web/dist";

const { port } = readApiConfig(process.env);
const { databaseUrl } = readDatabaseConfig(process.env);
const db = connect(databaseUrl);
// The API only sends jobs; the worker runs pg-boss's maintenance.
const boss = new PgBoss({
  connectionString: databaseUrl,
  supervise: false,
  schedule: false,
});
boss.on("error", (error) => {
  console.error("pg-boss error", error);
});
await boss.start();
await createQueues(boss);

const app = createApp({
  db,
  boss,
  store: storeFromConfig(readStorageConfig(process.env)),
  clock: systemClock,
  webhooks: readWebhookPolicy(process.env),
  chromiumPath: readExportConfig(process.env).chromiumPath,
  auth: createAuth(db.pool, readAuthConfig(process.env)),
  webDir: existsSync(WEB_DIR) ? WEB_DIR : undefined,
});
const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`api listening on :${String(info.port)}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    server.close((error) => {
      if (error) console.error(error);
      void Promise.allSettled([boss.stop({ graceful: true }), db.close()]).then(
        () => process.exit(error ? 1 : 0),
      );
    });
  });
}
