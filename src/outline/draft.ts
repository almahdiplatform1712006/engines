// A syllabus's contents pages, as the model read them, become a draft tree
// (E-16). Pure: the model reads names, depths and page numbers; plain code
// nests the entries and works out ranges. The uploader then edits and
// confirms, so nothing here is final.
import type { OutlineNodeInput, PrintedRange } from "../contract/outline.ts";

/** One line of a contents page, in reading order. */
export interface ContentsEntry {
  name: string;
  /** 1 for the outermost level (a unit), 2 inside it (a lesson), and so on. */
  depth: number;
  /** The level's own word, as the page writes it ("الوحدة", "Lesson"), or null. */
  level: string | null;
  /** The printed page it starts on, or null when the page doesn't say. */
  from: number | null;
  /** The printed page it ends on, when the page gives a range. */
  to: number | null;
  /** The answers section at the back of the book. */
  answerKey: boolean;
}

interface Draft {
  entry: ContentsEntry;
  depth: number;
  children: Draft[];
}

/**
 * Nests the entries of every contents page (in order) into a tree and fills
 * each range. A node without an end page ends the page before the next node
 * at its depth or shallower starts, or on that page when it starts on the
 * same one (siblings may share a boundary page). A parent without pages spans
 * its children. The book's last node has no next one: a leaf's end stays open
 * for the uploader to fill in, and a parent reaches its children's last page.
 */
export function draftTree(
  pages: readonly (readonly ContentsEntry[])[],
): OutlineNodeInput[] {
  const entries = pages.flat().filter((e) => e.name.trim() !== "");
  const roots: Draft[] = [];
  const stack: Draft[] = [];
  for (const entry of entries) {
    // A depth that skips levels hangs under the nearest open one.
    while (stack.length > 0 && (stack.at(-1)?.depth ?? 0) >= entry.depth)
      stack.pop();
    const draft: Draft = { entry, depth: entry.depth, children: [] };
    const parent = stack.at(-1);
    if (parent) parent.children.push(draft);
    else roots.push(draft);
    stack.push(draft);
  }

  // Where each entry's successor at its depth or shallower starts, in order.
  const nextStart = new Map<Draft, number | null>();
  const flat = flatten(roots);
  flat.forEach((draft, i) => {
    let next: number | null = null;
    for (const later of flat.slice(i + 1)) {
      if (later.depth <= draft.depth && later.entry.from !== null) {
        next = later.entry.from;
        break;
      }
    }
    nextStart.set(draft, next);
  });

  const build = (draft: Draft): OutlineNodeInput => {
    const children = draft.children.map(build);
    const from = draft.entry.from ?? children[0]?.printed_pages?.from ?? null;
    let to = draft.entry.to;
    if (to === null && from !== null) {
      const next = nextStart.get(draft) ?? null;
      if (next !== null) to = Math.max(from, next === from ? next : next - 1);
      else to = lastPage(draft.children);
    }
    const range: PrintedRange | null =
      from !== null && to !== null ? { from, to } : null;
    return {
      name: draft.entry.name.trim(),
      level: draft.entry.level,
      printed_pages: range,
      ...(draft.entry.answerKey ? { kind: "answer_key" as const } : {}),
      children,
    };
  };
  return roots.map(build);
}

function flatten(drafts: readonly Draft[]): Draft[] {
  return drafts.flatMap((d) => [d, ...flatten(d.children)]);
}

/** The furthest page any descendant mentions: a parent reaches at least there. */
function lastPage(children: readonly Draft[]): number | null {
  const pages = flatten(children).flatMap((d) =>
    [d.entry.from, d.entry.to].filter((p): p is number => p !== null),
  );
  return pages.length > 0 ? Math.max(...pages) : null;
}
