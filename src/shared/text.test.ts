import assert from "node:assert/strict";
import { test } from "node:test";
import { matchKey, parsePrintedNumber, toAsciiDigits } from "./text.ts";

test("Arabic-Indic digits become ASCII", () => {
  assert.equal(toAsciiDigits("صفحة ٤٢ و ۱۷"), "صفحة 42 و 17");
});

test("a printed page number is the single number on the label", () => {
  assert.equal(parsePrintedNumber("٨٩"), 89);
  assert.equal(parsePrintedNumber("- 12 -"), 12);
  assert.equal(parsePrintedNumber("صفحة ٣"), 3);
  assert.equal(parsePrintedNumber("xii"), null);
  assert.equal(parsePrintedNumber("12 13"), null);
  assert.equal(parsePrintedNumber(null), null);
  assert.equal(parsePrintedNumber("0"), null);
});

test("match keys ignore diacritics, letter forms, case and punctuation", () => {
  assert.equal(
    matchKey("الدَّرْسُ الثَّالِث: قوانينُ نيوتن"),
    matchKey("الدرس الثالث - قوانين نيوتن"),
  );
  assert.equal(matchKey("المادة"), matchKey("الماده"));
  assert.equal(matchKey("Unit Two: FORCES"), "unit two forces");
});
