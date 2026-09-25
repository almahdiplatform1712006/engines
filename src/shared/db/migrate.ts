import { fileURLToPath } from "node:url";
import { runner } from "node-pg-migrate";

const migrationsDir = fileURLToPath(
  new URL("../../../migrations", import.meta.url),
);

/** Applies every pending migration and returns the names of those it ran. */
export async function runMigrations(
  databaseUrl: string,
  log: (message: string) => void = () => undefined,
): Promise<string[]> {
  const applied = await runner({
    databaseUrl,
    dir: migrationsDir,
    migrationsTable: "pgmigrations",
    direction: "up",
    checkOrder: true,
    log,
  });
  return applied.map((migration) => migration.name);
}
