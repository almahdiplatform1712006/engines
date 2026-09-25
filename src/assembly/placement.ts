// Placement (spec #1 §4 step 5, decisions Q6, Q15, Q16; E-08). Plain code: the
// model reads pages, this decides where each block belongs (hard rule 4).
//
// - The deepest node whose range contains the page wins; pages in a unit's
//   range but no lesson's file under the unit.
// - A page inside two nodes' ranges (one ends and the next starts on it) is
//   split in reading order at the heading naming the later node (or one of its
//   ancestors that doesn't hold the earlier node). Blocks before it go to the
//   earlier node, blocks after it to the later one. No such heading: every
//   block on the page goes to the earlier node, flagged `heading_not_found`.
// - `idea_tag` is the nearest sub-heading (one that names no node) before the
//   block inside the same node, carried across pages.
import type { Locator } from "../contract/document.ts";
import { pdfToPrinted, type OffsetSegment } from "../offset/segments.ts";
import type { Block, PageReading } from "../reading/blocks.ts";
import { matchKey } from "../shared/text.ts";
import type { IndexedNode, TreeIndex } from "./tree-index.ts";

export interface Placed {
  block: Block;
  node: IndexedNode;
  locator: Locator;
  idea_tag: string | null;
  /** A review reason when the placement is uncertain. */
  flag: "heading_not_found" | null;
}

export interface Placement {
  /** Every block but `neither`, in reading order (page, then order on the page). */
  placed: Placed[];
  /** PDF page → number of blocks that fell outside every node's range. */
  unmapped: Map<number, number>;
}

export function place(
  index: TreeIndex,
  segments: readonly OffsetSegment[],
  pages: readonly PageReading[],
): Placement {
  const placed: Placed[] = [];
  const unmapped = new Map<number, number>();
  const subheading = new Map<string, string>();
  const namesNode = (text: string) =>
    index.nodes.some((n) => headingNames(text, n));

  for (const page of [...pages].sort((a, b) => a.pdf_page - b.pdf_page)) {
    const content = page.blocks.filter((b) => b.kind !== "neither");
    const printed = pdfToPrinted(segments, page.pdf_page);
    const locator = { pdf_page: page.pdf_page, printed_page: printed };
    const candidates = (printed === null ? [] : index.deepest(printed)).sort(
      (a, b) => a.from - b.from || a.depth - b.depth,
    );
    const [first, ...later] = candidates;
    if (first === undefined) {
      if (content.length > 0) unmapped.set(page.pdf_page, content.length);
      continue;
    }

    // Where each later node starts on this page, if its heading is here.
    const starts = new Map<number, IndexedNode>();
    let missing = false;
    for (const node of later) {
      const at = content.findIndex(
        (b) =>
          b.kind === "heading" &&
          [node, ...node.ancestors.map((a) => index.byId.get(a.id))].some(
            (candidate) =>
              candidate !== undefined &&
              !first.ancestors.includes(candidate.node) &&
              candidate.node !== first.node &&
              headingNames(b.text, candidate),
          ),
      );
      if (at === -1) missing = true;
      else starts.set(at, node);
    }

    let current = first;
    content.forEach((block, i) => {
      const start = missing ? undefined : starts.get(i);
      if (start) current = start;
      if (block.kind === "heading") {
        if (namesNode(block.text)) subheading.delete(current.node.id);
        else subheading.set(current.node.id, block.text);
      }
      placed.push({
        block,
        node: current,
        locator,
        idea_tag:
          block.kind === "heading"
            ? null
            : (subheading.get(current.node.id) ?? null),
        flag: missing ? "heading_not_found" : null,
      });
    });
  }
  return { placed, unmapped };
}

/** Whether heading text names the node: one contains the other, after normalising. */
export function headingNames(text: string, node: IndexedNode): boolean {
  const heading = matchKey(text);
  const name = matchKey(node.node.name);
  if (heading.length === 0 || name.length === 0) return false;
  if (heading === name) return true;
  if (name.length >= 4 && heading.includes(name)) return true;
  // "الدرس الثاني - القوة" names "الدرس الثاني: القوة"; so does "القوة" alone
  // when the book's heading is only the lesson's title.
  const title = matchKey(node.node.name.split(/[:：\-–—]/).at(-1) ?? "");
  return (
    title.length >= 4 &&
    heading.includes(title) &&
    heading.length <= name.length + 20
  );
}
