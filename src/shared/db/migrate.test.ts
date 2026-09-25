import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import {
  createTestDatabase,
  type TestDatabase,
} from "../../../test/database.ts";
import { runMigrations } from "./migrate.ts";

let db: TestDatabase;
before(async () => {
  db = await createTestDatabase();
});
after(async () => {
  await db.drop();
});

test("migrations apply cleanly to an empty database, then are a no-op", async () => {
  assert.deepEqual(await runMigrations(db.url), ["0001_init"]);
  assert.deepEqual(await runMigrations(db.url), []);
});
