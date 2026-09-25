// The numbers spec #1 fixes, in one place (decisions Q35, Q36; §3).
import { DAY_MS } from "./clock.ts";

/** A book may be up to 800 pages… */
export const MAX_PAGES = 800;
/** …and up to 500 MB. */
export const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;
/** Results, page images and exports are kept this long. */
export const DOCUMENT_TTL_DAYS = 30;
/** Unused uploads are deleted after 2 days, like the bucket's lifecycle rule. */
export const UPLOAD_TTL_DAYS = 2;
/** An `Idempotency-Key` is remembered this long. */
export const IDEMPOTENCY_TTL_MS = DAY_MS;
