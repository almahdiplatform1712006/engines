// Text normalisation shared by the golden-set scorers, the offset fit, heading
// matching and answer matching, so they all agree on what "the same" means.

const TATWEEL = /ـ/g; // U+0640 tatweel
const ALEF_FORMS = /[آأإٱ]/g; // U+0622 U+0623 U+0625 U+0671 → U+0627
const YA_FORMS = /[ىی]/g; // U+0649 alef maqsura, U+06CC Farsi yeh → U+064A
const TA_MARBUTA = /ة/g; // U+0629 → U+0647
const DIACRITICS = /[ً-ٰٟۖ-ۭ]/g; // harakat, shadda, sukun, Quranic marks
const ARABIC_INDIC_DIGIT = /[٠-٩]/g; // U+0660–U+0669
const EASTERN_ARABIC_INDIC_DIGIT = /[۰-۹]/g; // U+06F0–U+06F9

/** Arabic-Indic and Eastern Arabic-Indic digits → ASCII. */
export function toAsciiDigits(text: string): string {
  return text
    .replace(ARABIC_INDIC_DIGIT, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(EASTERN_ARABIC_INDIC_DIGIT, (d) =>
      String(d.charCodeAt(0) - 0x06f0),
    );
}

/**
 * Normalises Arabic text before comparing it: strips tatweel, unifies alef and
 * ya forms, turns Arabic-Indic digits into ASCII and collapses whitespace.
 */
export function normalizeArabic(text: string): string {
  return toAsciiDigits(
    text.replace(TATWEEL, "").replace(ALEF_FORMS, "ا").replace(YA_FORMS, "ي"),
  )
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * A stricter key for matching headings and names: `normalizeArabic`, then no
 * diacritics, ta marbuta as ha, lower case, and punctuation as spaces.
 */
export function matchKey(text: string): string {
  return normalizeArabic(
    text.replace(DIACRITICS, "").replace(TA_MARBUTA, "ه").toLowerCase(),
  )
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * A printed page number as an integer: the one run of digits in the text after
 * normalising them. Null for no number, several numbers (a spread) or Roman
 * numerals, which never take part in the offset fit.
 */
export function parsePrintedNumber(raw: string | null): number | null {
  if (raw === null) return null;
  const numbers = toAsciiDigits(raw).match(/\d+/g);
  if (numbers?.length !== 1) return null;
  const value = Number(numbers[0]);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}
