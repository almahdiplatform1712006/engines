import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { readApiConfig, readDatabaseConfig } from "./config.ts";

describe("readApiConfig", () => {
  test("listens on 8080 when PORT is unset", () => {
    assert.deepEqual(readApiConfig({}), { port: 8080 });
  });

  test("uses PORT when set", () => {
    assert.deepEqual(readApiConfig({ PORT: "3000" }), { port: 3000 });
  });

  test("rejects a PORT that is not a port number", () => {
    assert.throws(() => readApiConfig({ PORT: "eighty" }), /PORT/);
    assert.throws(() => readApiConfig({ PORT: "70000" }), /PORT/);
  });
});

describe("readDatabaseConfig", () => {
  test("reads DATABASE_URL", () => {
    assert.deepEqual(
      readDatabaseConfig({
        DATABASE_URL: "postgres://engines:engines@localhost:5432/engines",
      }),
      { databaseUrl: "postgres://engines:engines@localhost:5432/engines" },
    );
  });

  test("refuses to start without DATABASE_URL", () => {
    assert.throws(() => readDatabaseConfig({}), /DATABASE_URL/);
  });

  test("refuses a DATABASE_URL that is not a Postgres URL", () => {
    assert.throws(
      () => readDatabaseConfig({ DATABASE_URL: "mysql://localhost/engines" }),
      /DATABASE_URL/,
    );
  });
});
