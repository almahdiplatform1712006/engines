// When each sentence of a scene's narration is spoken. The voice gives no
// timestamps, so the default aligner shares the measured audio length out by
// sentence length. A forced aligner (wav2vec2) can replace it behind the same
// interface for word-level timing without touching the templates.

export interface Span {
  text: string;
  /** Seconds from the start of the scene's audio. */
  start: number;
  end: number;
}

export interface Aligner {
  align(input: { text: string; audioSeconds: number }): Promise<Span[]>;
}

/** Sentences of Arabic or Latin prose, keeping their ending marks. */
export function splitSentences(text: string): string[] {
  return (text.match(/[^.!?؟؛…\n]+[.!?؟؛…]*/gu) ?? [])
    .map((s) => s.trim())
    .filter((s) => /[\p{L}\p{N}]/u.test(s));
}

/** Time by share of letters and digits: a longer sentence takes longer to say. */
export function alignBySentence(text: string, audioSeconds: number): Span[] {
  const sentences = splitSentences(text);
  if (sentences.length === 0) return [];
  const weights = sentences.map((s) =>
    Math.max(1, s.match(/[\p{L}\p{N}]/gu)?.length ?? 1),
  );
  const total = weights.reduce((a, b) => a + b, 0);
  let at = 0;
  return sentences.map((sentence, i) => {
    const start = at;
    at += ((weights[i] ?? 1) / total) * audioSeconds;
    return {
      text: sentence,
      start,
      end: i === sentences.length - 1 ? audioSeconds : at,
    };
  });
}

export const sentenceAligner: Aligner = {
  align: ({ text, audioSeconds }) =>
    Promise.resolve(alignBySentence(text, audioSeconds)),
};

/**
 * The moment each of `count` revealed items appears: at the start of the
 * sentence it belongs to when the narration has at least that many, spread
 * evenly across the audio otherwise. The first item shows almost at once.
 */
export function revealTimes(
  count: number,
  spans: Span[],
  audioSeconds: number,
): number[] {
  if (count === 0) return [];
  const times: number[] = [];
  for (let k = 0; k < count; k++) {
    const span =
      spans.length >= count
        ? spans[Math.floor((k * spans.length) / count)]
        : undefined;
    times.push(span ? span.start : (k / count) * audioSeconds);
  }
  return times.map((t, k) => Math.max(t, k === 0 ? 0.3 : t));
}
