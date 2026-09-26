// Printed → PDF page mapping (spec #1 §3 `offset`, ADR 0001).
//
// A book's mapping is one or more segments in PDF order. Segment i maps printed
// page p to PDF page p + (pdf_from - printed_from), for printed pages from its
// `printed_from` up to just before the next segment starts (in printed and in PDF
// pages). PDF pages no segment covers (front matter, an unnumbered plate between
// segments) have no printed number.
import { z } from "zod";

export const OffsetSegment = z.object({
  printed_from: z.int().min(1),
  pdf_from: z.int().min(1),
  confirmed: z.boolean(),
});
export type OffsetSegment = z.infer<typeof OffsetSegment>;

/** The mapping for a book whose printed numbers are its PDF page numbers. */
export const IDENTITY: readonly OffsetSegment[] = [
  { printed_from: 1, pdf_from: 1, confirmed: true },
];

interface Span {
  printedFrom: number;
  /** Inclusive; Infinity for the last segment. */
  printedTo: number;
  shift: number;
}

function spans(segments: readonly OffsetSegment[]): Span[] {
  const sorted = [...segments].sort((a, b) => a.pdf_from - b.pdf_from);
  return sorted.map((segment, i) => {
    const next = sorted[i + 1];
    const shift = segment.pdf_from - segment.printed_from;
    return {
      printedFrom: segment.printed_from,
      // Up to the page before the next segment starts, in printed numbers and in
      // PDF pages both: a scan missing a page shifts back, and the two must not overlap.
      printedTo: next
        ? Math.min(next.printed_from - 1, next.pdf_from - 1 - shift)
        : Number.POSITIVE_INFINITY,
      shift,
    };
  });
}

/** The printed number a PDF page should carry, or null when no segment covers it. */
export function pdfToPrinted(
  segments: readonly OffsetSegment[],
  pdfPage: number,
): number | null {
  for (const span of spans(segments)) {
    const printed = pdfPage - span.shift;
    if (printed >= span.printedFrom && printed <= span.printedTo)
      return printed;
  }
  return null;
}

/** The PDF page a printed page falls on, or null when no segment covers it. */
export function printedToPdf(
  segments: readonly OffsetSegment[],
  printed: number,
): number | null {
  for (const span of spans(segments)) {
    if (printed >= span.printedFrom && printed <= span.printedTo) {
      return printed + span.shift;
    }
  }
  return null;
}

/**
 * Problems that make a mapping ambiguous: segments whose printed numbers do not
 * rise with their PDF pages (a restart at 1 would map one printed page twice).
 */
export function segmentProblems(segments: readonly OffsetSegment[]): string[] {
  const sorted = [...segments].sort((a, b) => a.pdf_from - b.pdf_from);
  const problems: string[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const before = sorted[i - 1];
    const segment = sorted[i];
    if (!before || !segment) continue;
    if (segment.pdf_from === before.pdf_from) {
      problems.push(
        `Two segments start on PDF page ${String(segment.pdf_from)}.`,
      );
    } else if (segment.printed_from <= before.printed_from) {
      problems.push(
        `Printed page ${String(segment.printed_from)} on PDF page ${String(segment.pdf_from)} does not come after printed page ${String(before.printed_from)}.`,
      );
    }
  }
  return problems;
}
