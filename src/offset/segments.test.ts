import assert from "node:assert/strict";
import { test } from "node:test";
import {
  IDENTITY,
  pdfToPrinted,
  printedToPdf,
  segmentProblems,
  type OffsetSegment,
} from "./segments.ts";

// Front matter of 4 pages, then an unnumbered plate after printed page 45.
const book: OffsetSegment[] = [
  { printed_from: 1, pdf_from: 5, confirmed: true },
  { printed_from: 46, pdf_from: 51, confirmed: true },
];

test("the identity mapping leaves page numbers alone", () => {
  assert.equal(pdfToPrinted(IDENTITY, 7), 7);
  assert.equal(printedToPdf(IDENTITY, 7), 7);
});

test("front matter has no printed number", () => {
  assert.equal(pdfToPrinted(book, 4), null);
  assert.equal(pdfToPrinted(book, 5), 1);
});

test("a shift after an unnumbered plate", () => {
  assert.equal(pdfToPrinted(book, 49), 45);
  assert.equal(pdfToPrinted(book, 50), null, "the plate");
  assert.equal(pdfToPrinted(book, 51), 46);
  assert.equal(printedToPdf(book, 45), 49);
  assert.equal(printedToPdf(book, 46), 51);
  assert.equal(printedToPdf(book, 300), 305);
});

test("a restart in numbering is ambiguous", () => {
  assert.equal(segmentProblems(book).length, 0);
  assert.equal(
    segmentProblems([
      { printed_from: 1, pdf_from: 3, confirmed: true },
      { printed_from: 1, pdf_from: 90, confirmed: true },
    ]).length,
    1,
  );
});
