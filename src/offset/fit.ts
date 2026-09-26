// The offset check (spec #1 §1 step 5, §4 steps 1b and 3; E-07). Pure.
import { pdfToPrinted, type OffsetSegment } from "./segments.ts";

/** A printed number read from one PDF page (null when none was read). */
export interface NumberPair {
  pdf_page: number;
  printed: number | null;
}

const EDGE = 20;
const MAX_SAMPLES = 50;

/**
 * Pages the quick pass reads: the first and last 20 and every 10th page in
 * between, thinned so a long book still costs about 50 cheap calls.
 */
export function samplePages(pageCount: number): number[] {
  if (pageCount <= 2 * EDGE) return range(1, pageCount);
  const middleFrom = EDGE + 1;
  const middleTo = pageCount - EDGE;
  const room = MAX_SAMPLES - 2 * EDGE;
  const step = Math.max(10, Math.ceil((middleTo - middleFrom + 1) / room));
  const middle: number[] = [];
  for (
    let page = Math.ceil(middleFrom / step) * step;
    page <= middleTo;
    page += step
  )
    middle.push(page);
  return [
    ...range(1, EDGE),
    ...middle.slice(0, room),
    ...range(middleTo + 1, pageCount),
  ];
}

export interface Fit {
  segments: OffsetSegment[];
  /** Share of the pages with a number that agree with the segments (0–1). */
  agreement: number;
  /** How many pages with a number were read. */
  numbered: number;
}

/**
 * Fits `pdf = printed + shift` piecewise: runs of consecutive samples with the
 * same shift become segments. A run shorter than two samples is taken as a
 * misread and ignored. Each segment starts at its first sample; the first one
 * reaches back to printed page 1 where the PDF allows.
 */
export function fitSegments(pairs: readonly NumberPair[]): Fit {
  const numbered = pairs
    .filter(
      (p): p is { pdf_page: number; printed: number } =>
        p.printed !== null && p.printed >= 1,
    )
    .sort((a, b) => a.pdf_page - b.pdf_page);

  const runs: {
    shift: number;
    first: { pdf_page: number; printed: number };
    size: number;
  }[] = [];
  for (const pair of numbered) {
    const shift = pair.pdf_page - pair.printed;
    const last = runs.at(-1);
    if (last?.shift === shift) last.size++;
    else runs.push({ shift, first: pair, size: 1 });
  }

  const kept: typeof runs = [];
  for (const run of runs.filter((r) => r.size >= 2)) {
    const last = kept.at(-1);
    if (last?.shift === run.shift) last.size += run.size;
    // Printed numbers must rise with PDF pages; a run that goes backwards is noise.
    else if (last === undefined || run.first.printed > last.first.printed)
      kept.push({ ...run });
  }

  const segments: OffsetSegment[] = kept.map((run, i) => ({
    printed_from: i === 0 ? Math.max(1, 1 - run.shift) : run.first.printed,
    pdf_from: 0,
    confirmed: false,
  }));
  segments.forEach((segment, i) => {
    segment.pdf_from = segment.printed_from + (kept[i]?.shift ?? 0);
  });

  const agreeing = numbered.filter(
    (p) => pdfToPrinted(segments, p.pdf_page) === p.printed,
  ).length;
  return {
    segments,
    agreement: numbered.length === 0 ? 0 : agreeing / numbered.length,
    numbered: numbered.length,
  };
}

/** `offset: "auto"` confirms a fit this good without asking. */
export function autoApprovable(fit: Fit): boolean {
  return fit.segments.length > 0 && fit.agreement >= 0.9 && fit.numbered >= 5;
}

export interface Break {
  pdf_page: number;
  expected: number;
  read: number | null;
}

/**
 * Step 3: pages whose printed number contradicts the confirmed segments. A page
 * with no number inside a segment is a break too when the nearest numbered page
 * on either side disagrees: the offset has drifted around it. An unnumbered
 * title page between agreeing pages can't be misplaced, and a book with no page
 * numbers at all has nothing to contradict.
 */
export function checkPages(
  segments: readonly OffsetSegment[],
  pages: readonly { pdf_page: number; printed_number: number | null }[],
): Break[] {
  const sorted = [...pages].sort((a, b) => a.pdf_page - b.pdf_page);
  // A numbered neighbour only speaks for the offset inside a segment: front
  // matter with its own numbering says nothing about the page after it.
  const agrees = (page: { pdf_page: number; printed_number: number | null }) =>
    pdfToPrinted(segments, page.pdf_page) === page.printed_number;
  const inSegment = (page: {
    pdf_page: number;
    printed_number: number | null;
  }) =>
    page.printed_number !== null &&
    pdfToPrinted(segments, page.pdf_page) !== null;

  const breaks: Break[] = [];
  sorted.forEach((page, i) => {
    const expected = pdfToPrinted(segments, page.pdf_page);
    if (expected === null) return;
    if (page.printed_number !== null) {
      if (page.printed_number !== expected)
        breaks.push({
          pdf_page: page.pdf_page,
          expected,
          read: page.printed_number,
        });
      return;
    }
    const before = sorted.slice(0, i).reverse().find(inSegment);
    const after = sorted.slice(i + 1).find(inSegment);
    // No numbered neighbour at all (a book without page numbers) contradicts nothing.
    if ((before && !agrees(before)) || (after && !agrees(after))) {
      breaks.push({ pdf_page: page.pdf_page, expected, read: null });
    }
  });
  return breaks;
}

function range(from: number, to: number): number[] {
  return Array.from({ length: Math.max(0, to - from + 1) }, (_, i) => from + i);
}
