import type { Ratio } from "./ratio.ts";

const TATWEEL = /ـ/g; // U+0640 tatweel
const ALEF_FORMS = /[آأإٱ]/g; // U+0622 U+0623 U+0625 U+0671 → U+0627
const YA_FORMS = /[ىی]/g; // U+0649 alef maqsura, U+06CC Farsi yeh → U+064A
const ARABIC_INDIC_DIGIT = /[٠-٩]/g; // U+0660–U+0669
const EASTERN_ARABIC_INDIC_DIGIT = /[۰-۹]/g; // U+06F0–U+06F9

/**
 * Normalises Arabic text before comparing it: strips tatweel, unifies alef and
 * ya forms, turns Arabic-Indic digits into ASCII and collapses whitespace.
 */
export function normalizeArabic(text: string): string {
  return text
    .replace(TATWEEL, "")
    .replace(ALEF_FORMS, "ا")
    .replace(YA_FORMS, "ي")
    .replace(ARABIC_INDIC_DIGIT, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(EASTERN_ARABIC_INDIC_DIGIT, (d) =>
      String(d.charCodeAt(0) - 0x06f0),
    )
    .replace(/\s+/g, " ")
    .trim();
}

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
