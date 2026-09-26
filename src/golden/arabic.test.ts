import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { normalizeArabic } from "../shared/text.ts";
import { characterErrorRate } from "./arabic.ts";

describe("normalizeArabic", () => {
  test("strips tatweel", () => {
    assert.equal(normalizeArabic("العـــلوم"), "العلوم");
  });

  test("unifies alef forms to bare alef", () => {
    assert.equal(normalizeArabic("أإآٱا"), "ااااا");
  });

  test("unifies alef maqsura and Farsi yeh to ya", () => {
    assert.equal(normalizeArabic("على یوم"), "علي يوم");
  });

  test("turns Arabic-Indic and Eastern Arabic-Indic digits into ASCII", () => {
    assert.equal(
      normalizeArabic("٠١٢٣٤٥٦٧٨٩ ۰۱۲۳۴۵۶۷۸۹"),
      "0123456789 0123456789",
    );
  });

  test("collapses runs of whitespace and trims", () => {
    assert.equal(normalizeArabic("  قانون \n\n نيوتن\t "), "قانون نيوتن");
  });
});

describe("characterErrorRate", () => {
  test("is 0 for identical text", () => {
    assert.deepEqual(characterErrorRate("نيوتن", "نيوتن"), { num: 0, den: 5 });
  });

  test("counts substitutions, insertions and deletions against the truth length", () => {
    // truth "kitten" → "sitting": 2 substitutions + 1 insertion.
    assert.deepEqual(characterErrorRate("kitten", "sitting"), {
      num: 3,
      den: 6,
    });
  });

  test("normalises both sides first, so spelling variants cost nothing", () => {
    assert.deepEqual(characterErrorRate("إلى ٣", "الي 3"), { num: 0, den: 5 });
  });

  test("counts Arabic letters as single characters", () => {
    // One letter deleted from a five-letter word.
    assert.deepEqual(characterErrorRate("نيوتن", "نوتن"), { num: 1, den: 5 });
  });
});
