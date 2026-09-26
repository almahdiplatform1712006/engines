import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import {
  createTestDatabase,
  type TestDatabase,
} from "../../../test/database.ts";
import { readdir } from "node:fs/promises";
import { runMigrations } from "./migrate.ts";

let db: TestDatabase;
before(async () => {
  db = await createTestDatabase();
});
after(async () => {
  await db.drop();
});

test("migrations apply cleanly to an empty database, then are a no-op", async () => {
  const files = (await readdir(new URL("../../../migrations", import.meta.url)))
    .filter((f) => f.endsWith(".sql"))
    .map((f) => f.replace(/\.sql$/, ""))
    .sort();
  assert.equal(files[0], "0001_init");
  assert.deepEqual(await runMigrations(db.url), files);
  assert.deepEqual(await runMigrations(db.url), []);
});
