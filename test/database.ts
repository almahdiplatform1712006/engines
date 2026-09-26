import { randomBytes } from "node:crypto";
import pg from "pg";

export interface TestDatabase {
  url: string;
  drop(): Promise<void>;
}

/**
 * Creates an empty database on the test server (DATABASE_URL, set by CI or by
 * test/global-setup.ts) so each test file starts from nothing.
 */
export async function createTestDatabase(): Promise<TestDatabase> {
  const serverUrl = process.env["DATABASE_URL"];
  if (!serverUrl) {
    throw new Error(
      "DATABASE_URL is unset. Run database tests through `npm test`.",
    );
  }

  const name = `engines_test_${randomBytes(6).toString("hex")}`;
  await withClient(serverUrl, (client) =>
    client.query(`CREATE DATABASE ${name}`),
  );

  const url = new URL(serverUrl);
  url.pathname = `/${name}`;

  return {
    url: url.toString(),
    drop: () =>
      withClient(serverUrl, (client) =>
        client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`),
      ),
  };
}

async function withClient(
  url: string,
  run: (client: pg.Client) => Promise<unknown>,
): Promise<void> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await run(client);
  } finally {
    await client.end();
  }
}
