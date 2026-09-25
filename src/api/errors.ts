// Every refusal leaves the API as `{ error: { code, message, details? } }`
// with the status spec #1 §3 gives its code.
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import { Refusal, type RefusalCode } from "../shared/refusal.ts";

const STATUS: Record<
  RefusalCode | "unauthorized" | "internal",
  ContentfulStatusCode
> = {
  invalid_request: 400,
  unauthorized: 401,
  insufficient_credits: 402,
  not_entitled: 403,
  forbidden: 403,
  not_found: 404,
  outline_not_confirmed: 409,
  outline_frozen: 409,
  upload_incomplete: 409,
  wrong_state: 409,
  gone: 410,
  too_large: 413,
  unsupported_file: 415,
  outline_invalid: 422,
  idempotency_mismatch: 422,
  too_many_jobs: 429,
  internal: 500,
};

export const ErrorBody = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});

export function errorResponse(c: Context, error: unknown): Response {
  if (error instanceof Refusal) {
    if (error.retryAfter !== undefined)
      c.header("Retry-After", String(error.retryAfter));
    return c.json(
      {
        error: {
          code: error.code,
          message: error.message,
          ...(error.details === undefined ? {} : { details: error.details }),
        },
      },
      STATUS[error.code],
    );
  }
  console.error(error);
  return c.json(
    {
      error: { code: "internal", message: "Something went wrong on our side." },
    },
    STATUS.internal,
  );
}

export function unauthorized(
  c: Context,
  message = "Send a valid API key as `Authorization: Bearer <key>`.",
): Response {
  return c.json(
    { error: { code: "unauthorized", message } },
    STATUS.unauthorized,
  );
}

/** The JSON body checked against a schema, or an `invalid_request` refusal. */
export async function readBody<T extends z.ZodType>(
  c: Context,
  schema: T,
): Promise<z.output<T>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new Refusal("invalid_request", "The request body must be JSON.");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new Refusal("invalid_request", z.prettifyError(parsed.error), {
      details: parsed.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    });
  }
  return parsed.data;
}
