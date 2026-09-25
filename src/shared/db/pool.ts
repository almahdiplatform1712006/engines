import pg from "pg";

/** A query runner: the pool, or one client inside a transaction. */
export interface Queryable {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<pg.QueryResult<R>>;
}

export interface Db extends Queryable {
  /** Runs `work` in one transaction: committed when it resolves, rolled back when it throws. */
  transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  /** The pool itself, for libraries that bring their own queries (Better Auth). */
  pool: pg.Pool;
}

// Postgres bigint and numeric come back as strings by default. Counts and money
// here fit comfortably in a JS number.
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => Number(value));
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (value) => Number(value));

export function connect(databaseUrl: string, max = 10): Db {
  const pool = new pg.Pool({ connectionString: databaseUrl, max });
  pool.on("error", (error) => {
    console.error("postgres pool error", error);
  });
  return {
    query: (text, values) => pool.query(text, values),
    async transaction(work) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await work(client);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
    pool,
  };
}
