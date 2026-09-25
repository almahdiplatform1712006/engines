import { normalizeArabic } from "../shared/text.ts";
import type { Ratio } from "./ratio.ts";

/**
 * Character error rate of `predicted` against `truth`, after normalising both:
 * edit distance over the truth's length, counted in Unicode code points.
 */
export function characterErrorRate(truth: string, predicted: string): Ratio {
  const t = Array.from(normalizeArabic(truth));
  const p = Array.from(normalizeArabic(predicted));
  return { num: editDistance(t, p), den: t.length };
}

/** 1 for identical text, falling to 0 as the normalised texts diverge. */
export function similarity(a: string, b: string): number {
  const x = Array.from(normalizeArabic(a));
  const y = Array.from(normalizeArabic(b));
  const longest = Math.max(x.length, y.length);
  return longest === 0 ? 1 : 1 - editDistance(x, y) / longest;
}

function editDistance(a: readonly string[], b: readonly string[]): number {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const substitution =
        (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      current.push(
        Math.min(
          (previous[j] ?? 0) + 1,
          (current[j - 1] ?? 0) + 1,
          substitution,
        ),
      );
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}
