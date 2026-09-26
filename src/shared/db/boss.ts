import type { Queryable } from "./pool.ts";

/** Handed to a pg-boss send as `db`, so the job commits with our transaction. */
export function inTransaction(tx: Queryable) {
  return {
    executeSql: (text: string, values?: unknown[]) => tx.query(text, values),
  };
}
