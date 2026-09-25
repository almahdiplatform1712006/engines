import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parsePrintedNumber } from "../shared/text.ts";
import { checkPages, fitSegments, samplePages } from "./fit.ts";
import type { OffsetSegment } from "./segments.ts";

/** Pairs for a book whose pdf page = printed + shift, sampled at `pdfPages`. */
function pairs(pdfPages: number[], printedOf: (pdf: number) => number | null) {
  return pdfPages.map((pdf) => ({ pdf_page: pdf, printed: printedOf(pdf) }));
}
const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);
const bare = (segments: OffsetSegment[]) =>
  segments.map((s) => [s.printed_from, s.pdf_from]);

describe("samplePages", () => {
  test("a short book is read in full", () => {
    assert.deepEqual(samplePages(30), range(1, 30));
  });

  test("the first and last 20 and every 10th page in between", () => {
    const pages = samplePages(120);
    assert.deepEqual(pages.slice(0, 20), range(1, 20));
    assert.deepEqual(pages.slice(-20), range(101, 120));
    assert.deepEqual(pages.slice(20, -20), [30, 40, 50, 60, 70, 80, 90, 100]);
  });

  test("never much more than 50 pages, whatever the length", () => {
    for (const count of [200, 500, 800]) {
      const pages = samplePages(count);
      assert.ok(
        pages.length <= 50,
        `${String(count)} pages sampled ${String(pages.length)}`,
      );
      assert.deepEqual(
        pages,
        [...new Set(pages)].sort((a, b) => a - b),
      );
    }
  });
});

describe("fitSegments", () => {
  test("front matter of four pages gives +4", () => {
    const fit = fitSegments(
      pairs(samplePages(120), (pdf) => (pdf <= 4 ? null : pdf - 4)),
    );
    assert.deepEqual(bare(fit.segments), [[1, 5]]);
    assert.equal(fit.agreement, 1);
  });

  test("a mid-book shift from +4 to +5 after an unnumbered plate", () => {
    const printedOf = (pdf: number) =>
      pdf <= 4 || pdf === 60 ? null : pdf <= 59 ? pdf - 4 : pdf - 5;
    const fit = fitSegments(pairs(range(1, 120), printedOf));
    assert.deepEqual(bare(fit.segments), [
      [1, 5],
      [56, 61],
    ]);
  });

  test("Arabic-Indic digits count like any others", () => {
    const labels = ["١", "٢", "٣", "٤", "٥"];
    const fit = fitSegments(
      labels.map((label, i) => ({
        pdf_page: i + 3,
        printed: parsePrintedNumber(label),
      })),
    );
    assert.deepEqual(bare(fit.segments), [[1, 3]]);
  });

  test("one misread page number is ignored", () => {
    const fit = fitSegments(
      pairs(range(1, 40), (pdf) => (pdf === 17 ? 71 : pdf - 2)),
    );
    assert.deepEqual(bare(fit.segments), [[1, 3]]);
    assert.ok(fit.agreement < 1 && fit.agreement > 0.95);
  });

  test("no numbers at all gives no segments", () => {
    const fit = fitSegments(pairs(range(1, 10), () => null));
    assert.deepEqual(fit.segments, []);
    assert.equal(fit.agreement, 0);
  });
});

describe("checkPages (step 3)", () => {
  const segments: OffsetSegment[] = [
    { printed_from: 1, pdf_from: 5, confirmed: true },
  ];

  test("a page whose number contradicts the offset is a break", () => {
    const breaks = checkPages(segments, [
      { pdf_page: 10, printed_number: 6 },
      { pdf_page: 11, printed_number: 9 },
      { pdf_page: 12, printed_number: 8 },
    ]);
    assert.deepEqual(
      breaks.map((b) => b.pdf_page),
      [11],
    );
  });

  test("an unnumbered page between agreeing pages is fine; next to a break it isn't", () => {
    const breaks = checkPages(segments, [
      { pdf_page: 10, printed_number: 6 },
      { pdf_page: 11, printed_number: null },
      { pdf_page: 12, printed_number: 8 },
      { pdf_page: 20, printed_number: null },
      { pdf_page: 21, printed_number: 30 },
    ]);
    assert.deepEqual(
      breaks.map((b) => b.pdf_page),
      [20, 21],
    );
  });

  test("a book without page numbers has nothing to contradict", () => {
    assert.deepEqual(
      checkPages(segments, [
        { pdf_page: 5, printed_number: null },
        { pdf_page: 6, printed_number: null },
      ]),
      [],
    );
  });

  test("numbered front matter outside the segments says nothing about the page after it", () => {
    assert.deepEqual(
      checkPages(segments, [
        { pdf_page: 4, printed_number: 3 },
        { pdf_page: 5, printed_number: null },
        { pdf_page: 6, printed_number: 2 },
      ]),
      [],
    );
  });

  test("pages outside every segment aren't checked", () => {
    assert.deepEqual(
      checkPages(segments, [{ pdf_page: 2, printed_number: null }]),
      [],
    );
  });
});
