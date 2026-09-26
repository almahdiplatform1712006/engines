// Refusals in plain words: the API's own message, with the ones people hit
// most spelled out in the page's language.
import { ApiError } from "./api.ts";
import type { useI18n } from "./i18n.tsx";

export function plain(
  error: unknown,
  t: ReturnType<typeof useI18n>["t"],
): string {
  if (error instanceof ApiError) {
    if (error.status === 402) return `${t.noCredits} ${error.message}`;
    if (error.status === 413) return `${t.tooLarge} ${error.message}`;
    return error.message;
  }
  return error instanceof Error ? error.message : t.error;
}

/** A refusal that won't change by asking again (not found, gone, not allowed). */
export function permanent(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 429
  );
}
