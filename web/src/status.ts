// The document statuses a job ends in. Kept here (checked against the
// contract's type) so the page doesn't bundle the contract's Zod schemas.
import type { DocumentStatus } from "../../src/contract/document.ts";

const TERMINAL_STATUSES = [
  "completed",
  "completed_with_errors",
  "failed",
] as const satisfies readonly DocumentStatus[];

export const TERMINAL: ReadonlySet<string> = new Set(TERMINAL_STATUSES);
