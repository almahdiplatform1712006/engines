// Answers (spec #1 §4 step 7, decision Q17; E-11). Pure. The book's own answer
// key comes first, then a visible mark on the page; only when neither exists
// does the model solve the question (done outside, flagged).
import type { Locator } from "../contract/document.ts";
import type { SolveRequest, SolvedAnswer } from "../reading/reader.ts";
import { matchKey, toAsciiDigits } from "../shared/text.ts";
import { flag } from "./checks.ts";
import type { StoredFailure, StoredQuestion } from "./result.ts";

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

export interface KeyMatch {
  /** Question id → the book's answer. */
  answers: Map<string, Answer>;
  /** Question id → a book answer that names none of the question's options. */
  mismatched: Map<string, string>;
  /** Entries that matched no question, or several. */
  unmatched: AnswerEntry[];
}

/**
 * Matches answer-key entries to questions by (lesson, question number).
 * `lessonOf` turns an entry's section into a node id (null when it names
 * none). An entry for a lesson matches the one question with its number in
 * that lesson; an entry without a lesson matches only a number that appears
 * once in the whole book. Anything ambiguous stays unmatched, and is reported.
 */
export function matchAnswerKey(
  entries: readonly AnswerEntry[],
  questions: readonly AnswerQuestion[],
  lessonOf: (section: string | null) => string | null,
  inLesson: (questionNode: string, lesson: string) => boolean = (a, b) =>
    a === b,
): KeyMatch {
  const match: KeyMatch = {
    answers: new Map(),
    mismatched: new Map(),
    unmatched: [],
  };
  for (const entry of entries) {
    const number = normaliseNumber(entry.number);
    const lesson = lessonOf(entry.section) ?? entry.node_id ?? null;
    const candidates =
      number === null
        ? []
        : questions.filter(
            (q) =>
              normaliseNumber(q.number) === number &&
              (lesson === null || inLesson(q.node_id, lesson)),
          );
    const [question] = candidates;
    if (candidates.length !== 1 || !question) {
      match.unmatched.push(entry);
      continue;
    }
    const answer = answerFor(entry.answer, question);
    if (answer) match.answers.set(question.id, answer);
    else match.mismatched.set(question.id, entry.answer);
  }
  return match;
}

/** Where a question's answer comes from, resolved for every question. */
export interface AnswerSources {
  /** The answer-key blocks, in reading order, with the node each was placed in. */
  keyBlocks: readonly {
    entries: readonly {
      section: string | null;
      number: string;
      answer: string;
    }[];
    /** The last heading before the block, standing in for a missing section. */
    heading: string | null;
    /** The content node the block sits in (answers at a lesson's end), else null. */
    node_id: string | null;
    locator: Locator;
  }[];
  lessonOf: (section: string | null) => string | null;
  inLesson: (questionNode: string, lesson: string) => boolean;
  /** Question id → option labels (or written answers) marked by hand. */
  marks: ReadonlyMap<string, readonly string[]>;
  /** Question id → what solving needs beyond the question: its passage and figure. */
  context: ReadonlyMap<
    string,
    { stimulus: string | null; figure: SolveRequest["figure"] }
  >;
  /** The model's answers, once the solve stage ran. */
  solved: ReadonlyMap<string, SolvedAnswer> | undefined;
}

/**
 * Step 7: fills every question's answer — the book's key, then a mark on the
 * page, then the model's — and returns the questions left for the model, with
 * failures for answer-key entries that answered nothing. Model answers are
 * always flagged; a book answer that names no option is flagged, not fixed.
 */
export function resolveAnswers(
  questions: StoredQuestion[],
  sources: AnswerSources,
): { unanswered: SolveRequest[]; failures: StoredFailure[] } {
  const entries = sources.keyBlocks.flatMap((block) =>
    block.entries.map((entry) => ({
      ...entry,
      section: entry.section ?? block.heading,
      node_id: block.node_id,
      locator: block.locator,
    })),
  );
  const key = matchAnswerKey(
    entries,
    questions,
    sources.lessonOf,
    sources.inLesson,
  );

  const failures: StoredFailure[] = [];
  const unmatchedByPage = new Map<
    number,
    { locator: Locator; numbers: string[] }
  >();
  for (const entry of key.unmatched as typeof entries) {
    const page = unmatchedByPage.get(entry.locator.pdf_page) ?? {
      locator: entry.locator,
      numbers: [],
    };
    page.numbers.push(entry.number);
    unmatchedByPage.set(entry.locator.pdf_page, page);
  }
  for (const { locator, numbers } of unmatchedByPage.values()) {
    failures.push({
      reason: "unmatched_answer_key",
      locator,
      detail: `answer-key entries that matched no single question: ${numbers.join(", ")}`,
    });
  }

  const unanswered: SolveRequest[] = [];
  for (const question of questions) {
    const set = (answer: Answer, source: StoredQuestion["answer_source"]) => {
      question.correct = answer.correct;
      question.accepted_answers = answer.accepted_answers;
      question.answer_source = source;
    };
    if (key.mismatched.has(question.id)) flag(question, "book_answer_mismatch");
    const fromBook = key.answers.get(question.id);
    if (fromBook) {
      set(fromBook, "book");
      continue;
    }
    const fromMarks = markedAnswer(
      question,
      sources.marks.get(question.id) ?? [],
    );
    if (fromMarks) {
      set(fromMarks, "marked");
      continue;
    }
    if (sources.solved) {
      const fromModel = sources.solved.get(question.id);
      if (fromModel) {
        set(fromModel, "model");
        flag(question, "model_answer");
      } else {
        flag(question, "no_answer");
      }
      continue;
    }
    const context = sources.context.get(question.id);
    unanswered.push({
      question_id: question.id,
      number: question.number,
      type: question.type,
      text: question.text,
      options: question.options,
      stimulus: context?.stimulus ?? null,
      figure: context?.figure ?? null,
    });
  }
  return { unanswered, failures };
}

/** A hand mark on the page (a circle, tick or fill), when it names the question's options. */
function markedAnswer(
  question: AnswerQuestion,
  marks: readonly string[],
): Answer | null {
  if (marks.length === 0) return null;
  const answers = marks.map((mark) => answerFor(mark, question));
  if (answers.some((a) => a === null)) return null;
  return {
    correct: [...new Set(answers.flatMap((a) => a?.correct ?? []))],
    accepted_answers: [
      ...new Set(answers.flatMap((a) => a?.accepted_answers ?? [])),
    ],
  };
}
