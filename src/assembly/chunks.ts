// Explanation chunks (spec #1 §3 `explanation`, §4 step 8, decision Q7; E-12).
// Pure. One chunk per heading-bounded section inside a node, in Markdown with
// LaTeX. Engines doesn't embed them; each consumer embeds with its own model.
//
// - An oversized section is split at paragraph breaks, never inside a $$…$$
//   equation or a table, and every piece repeats the heading breadcrumb.
// - A tiny section merges into the section before it, only within one node.
import type { MathDirection } from "../contract/document.ts";
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
  const merged: Section[] = [];
  for (const section of sections) {
    const before = merged.at(-1);
    if (
      before?.node_id === section.node_id &&
      estimateTokens(section.markdown) < options.minTokens
    ) {
      before.markdown = `${before.markdown}\n\n### ${section.heading}\n\n${section.markdown}`;
      before.figures = [...before.figures, ...section.figures];
      before.pdf_pages = union(before.pdf_pages, section.pdf_pages);
      before.printed_pages = union(before.printed_pages, section.printed_pages);
      before.math_direction ??= section.math_direction;
    } else {
      merged.push({ ...section, figures: [...section.figures] });
    }
  }

  return merged.flatMap((section) => {
    const breadcrumb = `> ${[...section.node_path, section.heading].join(" › ")}`;
    return splitMarkdown(section.markdown, options.maxTokens).map(
      (body, i) => ({
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
      }),
    );
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
