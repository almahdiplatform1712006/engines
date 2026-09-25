// Explanation chunks (spec #1 §3 `explanation`, §4 step 8, decision Q7; E-12).
// Pure. One chunk per heading-bounded section inside a node, in Markdown with
// LaTeX. Engines doesn't embed them; each consumer embeds with its own model.
//
// - An oversized section is split at paragraph breaks, never inside a $$…$$
//   equation or a table, and every piece repeats the heading breadcrumb.
// - A tiny section merges into the section before it, only within one node.
import type { MathDirection } from "../contract/document.ts";
import { pdfToPrinted, type OffsetSegment } from "../offset/segments.ts";
import { isFigure, itemId } from "./items.ts";
import type { Placed } from "./placement.ts";
import type { StoredChunk, StoredImage } from "./result.ts";

export interface Section {
  id: string;
  node_id: string;
  node_path: string[];
  external_ref: string | null;
  heading: string;
  markdown: string;
  math_direction: MathDirection | null;
  figures: StoredImage[];
  /** The block each figure came from, in step with `figures`. */
  figure_blocks?: string[];
  pdf_pages: number[];
  printed_pages: number[];
}

export interface ChunkOptions {
  /** A section longer than this (in estimated tokens) is split. */
  maxTokens: number;
  /** A section shorter than this merges into the one before it in its node. */
  minTokens: number;
}

export const DEFAULT_CHUNKING: ChunkOptions = { maxTokens: 800, minTokens: 60 };

/** A rough token count: good enough to size chunks, and model-independent. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function chunkSections(
  sections: readonly Section[],
  options: ChunkOptions = DEFAULT_CHUNKING,
): StoredChunk[] {
  const tiny = (section: Section) =>
    estimateTokens(section.markdown) < options.minTokens;
  const absorb = (into: Section, from: Section, at: "end" | "start") => {
    const body = `### ${from.heading}\n\n${from.markdown}`;
    into.markdown =
      at === "end"
        ? `${into.markdown}\n\n${body}`
        : `${body}\n\n${into.markdown}`;
    into.figures = [...into.figures, ...from.figures];
    into.pdf_pages = union(into.pdf_pages, from.pdf_pages);
    into.printed_pages = union(into.printed_pages, from.printed_pages);
    into.math_direction ??= from.math_direction;
  };

  // A tiny section merges into the one before it in its node; the first tiny
  // section of a node merges forward instead. Never across nodes.
  const merged: Section[] = [];
  let carried = null as Section | null;
  for (const original of sections) {
    const section: Section = { ...original, figures: [...original.figures] };
    if (carried?.node_id === section.node_id) {
      absorb(section, carried, "start");
      section.heading = carried.heading;
      section.id = carried.id;
    } else if (carried) {
      merged.push(carried);
    }
    carried = null;
    const before = merged.at(-1);
    if (tiny(section) && before?.node_id === section.node_id) {
      absorb(before, section, "end");
    } else if (tiny(section) && section.figures.length === 0) {
      carried = section;
    } else {
      merged.push(section);
    }
  }
  if (carried) merged.push(carried);

  return merged.flatMap((section) => {
    const breadcrumb = `> ${[...section.node_path, section.heading].join(" › ")}`;
    // A section of figures alone still makes one chunk.
    const pieces = splitMarkdown(section.markdown, options.maxTokens);
    return (pieces.length > 0 ? pieces : [""]).map((body, i) => ({
      id: i === 0 ? section.id : `${section.id}_${String(i + 1)}`,
      node_id: section.node_id,
      node_path: section.node_path,
      external_ref: section.external_ref,
      heading: section.heading,
      markdown: `${breadcrumb}\n\n${body}`,
      math_direction: section.math_direction,
      // Figures go with the first piece.
      figures: i === 0 ? section.figures : [],
      pages: { pdf: section.pdf_pages, printed: section.printed_pages },
      review_required: false,
      review_reason: null,
    }));
  });
}

/**
 * Splits Markdown into pieces of at most `maxTokens`, at paragraph breaks.
 * A display equation or a table is one unit however many blank lines it holds;
 * a single unit larger than the limit is kept whole rather than cut.
 */
export function splitMarkdown(markdown: string, maxTokens: number): string[] {
  const pieces: string[] = [];
  let current: string[] = [];
  for (const unit of units(markdown)) {
    const candidate = [...current, unit].join("\n\n");
    if (current.length > 0 && estimateTokens(candidate) > maxTokens) {
      pieces.push(current.join("\n\n"));
      current = [unit];
    } else {
      current.push(unit);
    }
  }
  if (current.length > 0) pieces.push(current.join("\n\n"));
  return pieces;
}

/** Paragraphs, with every $$…$$ equation and every table kept in one unit. */
function units(markdown: string): string[] {
  const out: string[] = [];
  let open: string[] = [];
  const isTable = (p: string) => p.trimStart().startsWith("|");
  for (const paragraph of markdown.split(/\n\s*\n/)) {
    if (paragraph.trim() === "") continue;
    const last = open.at(-1);
    const insideMath =
      open.length > 0 && countDisplayDelimiters(open.join("\n\n")) % 2 === 1;
    const continuesTable =
      last !== undefined && isTable(last) && isTable(paragraph);
    if (insideMath || continuesTable) {
      open.push(paragraph);
      continue;
    }
    if (open.length > 0) out.push(open.join("\n\n"));
    open = [paragraph];
  }
  if (open.length > 0) out.push(open.join("\n\n"));
  return out;
}

function countDisplayDelimiters(text: string): number {
  return text.match(/\$\$/g)?.length ?? 0;
}

function union(a: readonly number[], b: readonly number[]): number[] {
  return [...new Set([...a, ...b])].sort((x, y) => x - y);
}

/**
 * Step 8's input: heading-bounded sections of explanation, in reading order. A
 * heading opens a section in its node; explanation in a node other than the
 * open section's opens a section headed by that node's name. Diagrams and
 * tables join the open section as figures (the caller drops those a question
 * uses). A section with neither text nor figures is dropped.
 */
export function gatherSections(
  placed: readonly Placed[],
  segments: readonly OffsetSegment[],
): Section[] {
  const all: Section[] = [];
  let current = null as Section | null;
  // A heading waiting for the text it heads (typed wide: set inside the loop).
  let pendingHeading = null as { text: string; node_id: string } | null;

  for (const { block, node } of placed) {
    if (block.kind === "heading") {
      pendingHeading = { text: block.text, node_id: node.node.id };
      current = null;
      continue;
    }
    const figure = isFigure(block);
    if (block.kind !== "explanation" && !figure) continue;

    if (current?.node_id !== node.node.id) {
      const heading: string =
        pendingHeading?.node_id === node.node.id
          ? pendingHeading.text
          : node.node.name;
      pendingHeading = null;
      current = {
        id: itemId("c", block.id),
        node_id: node.node.id,
        node_path: node.path,
        external_ref: node.node.external_ref,
        heading,
        markdown: "",
        math_direction: null,
        figures: [],
        figure_blocks: [],
        pdf_pages: [],
        printed_pages: [],
      };
      all.push(current);
    }
    if (figure) {
      current.figures.push({
        pdf_page: block.pdf_page,
        box: block.box,
        key: null,
      });
      current.figure_blocks?.push(block.id);
    } else {
      current.markdown =
        current.markdown === ""
          ? block.text
          : `${current.markdown}\n\n${block.text}`;
      current.math_direction ??= block.math_direction;
    }
    if (!current.pdf_pages.includes(block.pdf_page))
      current.pdf_pages.push(block.pdf_page);
    const printed = pdfToPrinted(segments, block.pdf_page);
    if (printed !== null && !current.printed_pages.includes(printed))
      current.printed_pages.push(printed);
  }
  return all;
}

/** Sections that still carry something once figures used by questions are taken out. */
export function withoutFigures(
  sections: readonly Section[],
  used: ReadonlySet<string>,
): Section[] {
  return sections
    .map((section) => {
      const blocks = section.figure_blocks ?? [];
      const keep = section.figures.map((_, i) => !used.has(blocks[i] ?? ""));
      return {
        ...section,
        figures: section.figures.filter((_, i) => keep[i]),
        figure_blocks: blocks.filter((_, i) => keep[i]),
      };
    })
    .filter(
      (section) => section.markdown.trim() !== "" || section.figures.length > 0,
    );
}
