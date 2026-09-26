import { readDatabaseConfig } from "../config.ts";
import { runMigrations } from "./migrate.ts";

const { databaseUrl } = readDatabaseConfig(process.env);
const applied = await runMigrations(databaseUrl, (message) => {
  console.log(message);
});
console.log(
  applied.length
    ? `applied ${String(applied.length)} migration(s): ${applied.join(", ")}`
    : "database is up to date",
);
