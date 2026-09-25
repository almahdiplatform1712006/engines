// Answers (spec #1 §4 step 7, decision Q17; E-11). Pure. The book's own answer
// key comes first, then a visible mark on the page; only when neither exists
// does the model solve the question (done outside, flagged).
import { matchKey, toAsciiDigits } from "../shared/text.ts";

export interface AnswerQuestion {
  id: string;
  node_id: string;
  number: string | null;
  type: "multiple_choice" | "fill_blank" | "true_false";
  options: readonly { key: string; text: string }[];
}

export interface AnswerEntry {
  section: string | null;
  number: string;
  answer: string;
  /** The lesson to use when the section names none (answers printed at a lesson's end). */
  node_id?: string | null;
}

export interface Answer {
  correct: string[];
  accepted_answers: string[];
}

/** A question number without its decoration: "(12)", "س٤-" and "Q 7." → "12", "4", "7". */
export function normaliseNumber(text: string | null): string | null {
  if (text === null) return null;
  const match = /\d+/.exec(toAsciiDigits(text));
  return match ? String(Number(match[0])) : null;
}

// Option letters in Arabic and Latin order, so a book that prints أ ب ج د on
// the questions and a b c d in the key (or the reverse) still matches.
const ARABIC_LETTERS = ["ا", "ب", "ج", "د", "ه", "و"];
const LATIN_LETTERS = ["a", "b", "c", "d", "e", "f"];
const TRUE_WORDS = new Set([
  "صح",
  "صحيح",
  "صحيحه",
  "صواب",
  "نعم",
  "true",
  "t",
  "yes",
  "✓",
  "✔",
]);
const FALSE_WORDS = new Set([
  "خطا",
  "خاطئ",
  "خاطئه",
  "غلط",
  "لا",
  "false",
  "f",
  "no",
  "✗",
  "✘",
  "x",
]);

/** A letter's place in the alphabet it belongs to, or null. */
function letterIndex(key: string): number | null {
  const k = matchKey(key);
  const i = Math.max(ARABIC_LETTERS.indexOf(k), LATIN_LETTERS.indexOf(k));
  return i === -1 ? null : i;
}

/**
 * The answer, as printed in a key or marked on the page, in the question's own
 * terms: option keys for multiple-choice and true/false, accepted answers for
 * fill-in-the-blank. Null when it names none of the question's options: a
 * failed check is flagged, never silently fixed.
 */
export function answerFor(
  raw: string,
  question: AnswerQuestion,
): Answer | null {
  const answer = raw.trim();
  if (answer === "") return null;
  if (question.type === "fill_blank")
    return { correct: [], accepted_answers: [answer] };

  const key = matchKey(answer);
  const byKey = question.options.find((o) => matchKey(o.key) === key);
  if (byKey) return { correct: [byKey.key], accepted_answers: [] };

  const index = letterIndex(answer);
  if (index !== null) {
    const byLetter = question.options.find((o) => letterIndex(o.key) === index);
    if (byLetter) return { correct: [byLetter.key], accepted_answers: [] };
  }

  const byText = question.options.find(
    (o) => matchKey(o.text) === key && key !== "",
  );
  if (byText) return { correct: [byText.key], accepted_answers: [] };

  if (question.type === "true_false") {
    const truth =
      TRUE_WORDS.has(key) || TRUE_WORDS.has(answer)
        ? true
        : FALSE_WORDS.has(key) || FALSE_WORDS.has(answer)
          ? false
          : null;
    if (truth !== null) {
      const option = question.options.find((o) => {
        const k = matchKey(o.key);
        const t = matchKey(o.text);
        const words = truth ? TRUE_WORDS : FALSE_WORDS;
        return words.has(k) || words.has(t);
      });
      if (option) return { correct: [option.key], accepted_answers: [] };
    }
  }
  return null;
}

/**
 * Matches answer-key entries to questions by (lesson, question number).
 * `lessonOf` turns an entry's section into a node id (null when it names
 * none). An entry for a lesson matches the one question with its number in
 * that lesson; an entry without a lesson matches only a number that appears
 * once in the whole book. Anything ambiguous stays unmatched.
 */
export function matchAnswerKey(
  entries: readonly AnswerEntry[],
  questions: readonly AnswerQuestion[],
  lessonOf: (section: string | null) => string | null,
  inLesson: (questionNode: string, lesson: string) => boolean = (a, b) =>
    a === b,
): Map<string, Answer> {
  const answers = new Map<string, Answer>();
  for (const entry of entries) {
    const number = normaliseNumber(entry.number);
    if (number === null) continue;
    const lesson = lessonOf(entry.section) ?? entry.node_id ?? null;
    const candidates = questions.filter(
      (q) =>
        normaliseNumber(q.number) === number &&
        (lesson === null || inLesson(q.node_id, lesson)),
    );
    const [question] = candidates;
    if (candidates.length !== 1 || !question) continue;
    const answer = answerFor(entry.answer, question);
    if (answer) answers.set(question.id, answer);
  }
  return answers;
}
