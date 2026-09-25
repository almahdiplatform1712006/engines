// Linking questions to shared passages, diagrams and tables (spec #1 §3
// `stimuli`, §4 step 6; E-10). Pure. A stimulus is stored once; its questions
// point at it with `stimulus_id`, following QTI's shared-stimulus concept.
//
// In order of certainty:
// 1. A stimulus that names the questions it covers ("answer questions 12–19")
//    links those numbers after it in the same node.
// 2. A question naming a stimulus's label ("use Figure 3") links to it.
// 3. A question with an instruction ("read the passage then answer") links to
//    the nearest stimulus above it, on its page or the one before, in its node.
//    When that page holds more than one candidate, the link is uncertain.
// 4. A question with no instruction under a stimulus on its page is linked to
//    it, uncertain, unless the stimulus names the questions it covers.
// Otherwise the question has no stimulus.
import { matchKey, toAsciiDigits } from "../shared/text.ts";

export interface LinkStimulus {
  id: string;
  node_id: string;
  pdf_page: number;
  /** Position in the document's reading order. */
  order: number;
  label: string | null;
  covers: { from: string; to: string } | null;
}

export interface LinkQuestion {
  id: string;
  node_id: string;
  pdf_page: number;
  order: number;
  number: string | null;
  stimulus_label: string | null;
}

export interface Link {
  stimulus_id: string;
  /** No clear instruction picked it out: flag `grouping_uncertain`. */
  uncertain: boolean;
}

/** How many pages back an instruction may reach for its stimulus. */
const REACH = 1;

export function linkStimuli(
  questions: readonly LinkQuestion[],
  stimuli: readonly LinkStimulus[],
): Map<string, Link> {
  const links = new Map<string, Link>();

  for (const question of questions) {
    const before = stimuli
      .filter(
        (s) =>
          s.node_id === question.node_id &&
          s.order < question.order &&
          s.pdf_page >= question.pdf_page - REACH,
      )
      .sort((a, b) => b.order - a.order);

    // 1. A stated range of question numbers.
    const number = asNumber(question.number);
    const covering = stimuli
      .filter(
        (s) =>
          s.node_id === question.node_id &&
          s.order < question.order &&
          s.covers,
      )
      .sort((a, b) => b.order - a.order)
      .find((s) => {
        const from = asNumber(s.covers?.from ?? null);
        const to = asNumber(s.covers?.to ?? null);
        return (
          number !== null &&
          from !== null &&
          to !== null &&
          number >= from &&
          number <= to
        );
      });
    if (covering) {
      links.set(question.id, { stimulus_id: covering.id, uncertain: false });
      continue;
    }

    const hint = question.stimulus_label;
    if (hint === null) {
      // No instruction at all: a stimulus above it on its page is still the
      // likely one, unless that stimulus names the questions it covers.
      const nearest = before[0];
      if (nearest?.pdf_page === question.pdf_page && nearest.covers === null) {
        links.set(question.id, { stimulus_id: nearest.id, uncertain: true });
      }
      continue;
    }

    // 2. A label the question names.
    const named = stimuli.filter(
      (s) =>
        s.node_id === question.node_id &&
        s.label !== null &&
        labelNamed(hint, s.label),
    );
    if (named.length === 1 && named[0]) {
      links.set(question.id, { stimulus_id: named[0].id, uncertain: false });
      continue;
    }

    // 3. An instruction: the nearest stimulus above.
    const nearest = before[0];
    if (!nearest) continue;
    const onItsPage = before.filter((s) => s.pdf_page === nearest.pdf_page);
    links.set(question.id, {
      stimulus_id: nearest.id,
      uncertain: onItsPage.length > 1 || named.length > 1,
    });
  }
  return links;
}

function asNumber(text: string | null): number | null {
  if (text === null) return null;
  const match = /\d+/.exec(toAsciiDigits(text));
  return match ? Number(match[0]) : null;
}

/** "use figure 3" names "Figure 3": the label, normalised, appears in the hint with its number. */
function labelNamed(hint: string, label: string): boolean {
  const h = matchKey(hint);
  const l = matchKey(label);
  if (l.length === 0) return false;
  if (h.includes(l)) return true;
  // A numbered label ("Figure 3", "الشكل ٣") matches a hint with the same number
  // and a word of the label ("figure 3", "شكل 3").
  const labelNumber = asNumber(label);
  const hintNumber = asNumber(hint);
  if (labelNumber === null || labelNumber !== hintNumber) return false;
  return l
    .split(" ")
    .some(
      (word) =>
        word.length >= 3 &&
        !/^\d+$/.test(word) &&
        h.includes(word.replace(/^ال/, "")),
    );
}
