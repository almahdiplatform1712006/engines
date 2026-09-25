// Scorers compare what a page reader returned for one page with the page's truth.
// Each returns a Ratio so that pages add up into book and run totals.
import katex from "katex";
import { characterErrorRate, normalizeArabic, similarity } from "./arabic.ts";
import type { Ratio } from "./ratio.ts";
import type { CropBox, PageContent, Question, Usage } from "./truth.ts";

/** Below this normalised-text similarity two items are not the same item. */
const MATCH_THRESHOLD = 0.7;

interface Pair<T> {
  truth: T;
  predicted: T;
}

/**
 * Pairs truth items with predicted items by the similarity of their text, best
 * pairs first, each item used at most once. Ids never line up between a truth
 * file and a reader's output, so text is the only fair key.
 */
function matchByText<T>(
  truth: readonly T[],
  predicted: readonly T[],
  text: (item: T) => string,
): Pair<T>[] {
  const candidates: { t: number; p: number; score: number }[] = [];
  truth.forEach((a, t) => {
    predicted.forEach((b, p) => {
      const score = similarity(text(a), text(b));
      if (score >= MATCH_THRESHOLD) candidates.push({ t, p, score });
    });
  });
  candidates.sort((a, b) => b.score - a.score);

  const usedTruth = new Set<number>();
  const usedPredicted = new Set<number>();
  const pairs: Pair<T>[] = [];
  for (const { t, p } of candidates) {
    if (usedTruth.has(t) || usedPredicted.has(p)) continue;
    const a = truth[t];
    const b = predicted[p];
    if (a === undefined || b === undefined) continue;
    usedTruth.add(t);
    usedPredicted.add(p);
    pairs.push({ truth: a, predicted: b });
  }
  return pairs;
}

function matchQuestions(truth: PageContent, predicted: PageContent) {
  return matchByText(truth.questions, predicted.questions, (q) => q.text);
}

/** Truth questions the reader found. */
export function questionRecall(
  truth: PageContent,
  predicted: PageContent,
): Ratio {
  return {
    num: matchQuestions(truth, predicted).length,
    den: truth.questions.length,
  };
}

/** Predicted questions that are real questions on the page. */
export function questionPrecision(
  truth: PageContent,
  predicted: PageContent,
): Ratio {
  return {
    num: matchQuestions(truth, predicted).length,
    den: predicted.questions.length,
  };
}

/** Matched questions whose options (key and text, in any order) are exactly the truth's. */
export function optionSetExactMatch(
  truth: PageContent,
  predicted: PageContent,
): Ratio {
  const pairs = matchQuestions(truth, predicted);
  const options = (q: Question) =>
    q.options.map(
      (o) => `${normalizeArabic(o.key)} ${normalizeArabic(o.text)}`,
    );
  return countWhere(pairs, (pair) =>
    sameSet(options(pair.truth), options(pair.predicted)),
  );
}

/** Matched questions whose correct answer is the truth's: option keys, or accepted answers for fill_blank. */
export function correctAnswerAccuracy(
  truth: PageContent,
  predicted: PageContent,
): Ratio {
  const pairs = matchQuestions(truth, predicted);
  const answers = (q: Question) =>
    (q.type === "fill_blank" ? q.accepted_answers : q.correct).map(
      normalizeArabic,
    );
  return countWhere(pairs, (pair) =>
    sameSet(answers(pair.truth), answers(pair.predicted)),
  );
}

/**
 * Matched questions linked to the right passage or diagram, or rightly linked to
 * none. Stimuli are matched by text, since the reader names them its own way.
 */
export function stimulusLinkAccuracy(
  truth: PageContent,
  predicted: PageContent,
): Ratio {
  const truthIdOf = new Map(
    matchByText(truth.stimuli, predicted.stimuli, (s) => s.text).map((pair) => [
      pair.predicted.id,
      pair.truth.id,
    ]),
  );
  const pairs = matchQuestions(truth, predicted);
  return countWhere(pairs, ({ truth: t, predicted: p }) =>
    p.stimulus_id === null
      ? t.stimulus_id === null
      : truthIdOf.get(p.stimulus_id) === t.stimulus_id,
  );
}

/**
 * Intersection over union of crop boxes, summed over matched questions and
 * stimuli whose truth has a crop. A missing predicted crop scores 0.
 */
export function cropIoU(truth: PageContent, predicted: PageContent): Ratio {
  const pairs: Pair<{ crop: CropBox | null }>[] = [
    ...matchQuestions(truth, predicted),
    ...matchByText(truth.stimuli, predicted.stimuli, (s) => s.text),
  ];
  let num = 0;
  let den = 0;
  for (const pair of pairs) {
    if (pair.truth.crop === null) continue;
    den += 1;
    if (pair.predicted.crop !== null)
      num += intersectionOverUnion(pair.truth.crop, pair.predicted.crop);
  }
  return { num, den };
}

function intersectionOverUnion(a: CropBox, b: CropBox): number {
  const w = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const h = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const intersection = w * h;
  const union = a.w * a.h + b.w * b.h - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Character error rate of the page's explanation text (headings and body, in order), after normalisation. */
export function explanationCER(
  truth: PageContent,
  predicted: PageContent,
): Ratio {
  const text = (page: PageContent) =>
    page.explanation
      .map((block) => `${block.heading}\n${block.markdown}`)
      .join("\n");
  return characterErrorRate(text(truth), text(predicted));
}

/** Whether the reader read the page's printed number, or rightly found none. */
export function printedPageAccuracy(
  truth: PageContent,
  predicted: PageContent,
): Ratio {
  return { num: truth.printed_page === predicted.printed_page ? 1 : 0, den: 1 };
}

// $$…$$, \[…\], \(…\) or $…$. An escaped \$ is a dollar sign, not math.
const MATH_SPAN =
  /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|(?<!\\)\$((?:\\\$|[^$])+?)(?<!\\)\$/g;

/** Math spans in the reader's output that KaTeX parses (`throwOnError`), as spec §4 step 9 checks. */
export function latexParseRate(predicted: PageContent): Ratio {
  const texts = [
    ...predicted.stimuli.map((s) => s.text),
    ...predicted.questions.flatMap((q) => [
      q.text,
      ...q.options.map((o) => o.text),
    ]),
    ...predicted.explanation.flatMap((b) => [b.heading, b.markdown]),
  ];
  let num = 0;
  let den = 0;
  for (const text of texts) {
    for (const match of text.matchAll(MATH_SPAN)) {
      const [, display, bracket, paren, inline] = match;
      const tex = display ?? bracket ?? paren ?? inline ?? "";
      den += 1;
      if (parsesInKatex(tex, display !== undefined || bracket !== undefined))
        num += 1;
    }
  }
  return { num, den };
}

function parsesInKatex(tex: string, displayMode: boolean): boolean {
  try {
    // strict: false only silences KaTeX's style warnings (such as Arabic outside \text); parse errors still throw.
    katex.renderToString(tex, {
      throwOnError: true,
      displayMode,
      strict: false,
    });
    return true;
  } catch {
    return false;
  }
}

/** One page's logged cost in US dollars. */
export function costPerPage(usage: Usage): Ratio {
  return { num: usage.cost_usd, den: 1 };
}

function countWhere<T>(
  items: readonly T[],
  predicate: (item: T) => boolean,
): Ratio {
  return { num: items.filter(predicate).length, den: items.length };
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const x = new Set(a);
  const y = new Set(b);
  return x.size === y.size && [...x].every((item) => y.has(item));
}
