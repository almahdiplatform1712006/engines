// Runs once before the test files. Database tests need a Postgres server:
// CI and `docker compose` provide one through DATABASE_URL. Without it we start
// a throwaway embedded Postgres so `npm test` works on a machine with no Docker.
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";

let embedded: { server: EmbeddedPostgres; dir: string } | undefined;

export async function globalSetup(): Promise<void> {
  if (process.env["DATABASE_URL"]) return;

  const dir = await mkdtemp(join(tmpdir(), "engines-test-pg-"));
  const port = await freePort();
  const server = new EmbeddedPostgres({
    databaseDir: dir,
    user: "engines",
    password: "engines",
    port,
    persistent: false,
    onLog: () => undefined,
  });
  await server.initialise();
  await server.start();
  embedded = { server, dir };

  process.env["DATABASE_URL"] =
    `postgres://engines:engines@localhost:${String(port)}/postgres`;
}

export async function globalTeardown(): Promise<void> {
  if (!embedded) return;
  await embedded.server.stop();
  await rm(embedded.dir, { recursive: true, force: true });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, () => {
      const address = probe.address();
      probe.close(() => {
        if (address && typeof address === "object") resolve(address.port);
        else reject(new Error("Could not find a free port"));
      });
    });
  });
}
