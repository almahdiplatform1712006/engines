// The checks every question passes before delivery (spec #1 §4 step 9). A
// failed check flags the question; it is never silently fixed.
import { latexValid } from "../shared/latex.ts";
import type { StoredQuestion } from "./result.ts";

export function questionChecks(question: StoredQuestion): string[] {
  const flags: string[] = [];
  const { type, options } = question;
  if (
    type === "multiple_choice" &&
    (options.length < 2 || options.length > 6)
  ) {
    flags.push("options_count");
  }
  if (
    type !== "fill_blank" &&
    question.correct.some((key) => !options.some((o) => o.key === key))
  ) {
    flags.push("answer_not_in_options");
  }
  if (
    type === "fill_blank" &&
    question.answer_source !== null &&
    question.accepted_answers.length === 0
  ) {
    flags.push("no_accepted_answers");
  }
  if (![question.text, ...options.map((o) => o.text)].every(latexValid)) {
    flags.push("latex_invalid");
  }
  return flags;
}

/** Marks an item for review. The first reason given stays the one shown. */
export function flag(
  item: { review_required: boolean; review_reason: string | null },
  reason: string,
): void {
  item.review_required = true;
  item.review_reason ??= reason;
}
