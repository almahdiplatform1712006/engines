// A request Engines refuses for a reason the caller can act on. Domain modules
// throw these; the API maps each code to its HTTP status (src/api/errors.ts).
export type RefusalCode =
  | "invalid_request"
  | "not_found"
  | "gone"
  | "outline_not_confirmed"
  | "outline_frozen"
  | "outline_invalid"
  | "upload_incomplete"
  | "unsupported_file"
  | "too_large"
  | "insufficient_credits"
  | "not_entitled"
  | "forbidden"
  | "too_many_jobs"
  | "idempotency_mismatch"
  | "wrong_state";

export class Refusal extends Error {
  override name = "Refusal";
  readonly code: RefusalCode;
  readonly details: unknown;
  /** Seconds, for `too_many_jobs`. */
  readonly retryAfter: number | undefined;

  constructor(
    code: RefusalCode,
    message: string,
    options: { details?: unknown; retryAfter?: number } = {},
  ) {
    super(message);
    this.code = code;
    this.details = options.details;
    this.retryAfter = options.retryAfter;
  }
}
