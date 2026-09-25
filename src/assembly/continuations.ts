// Pages that run on (spec #1 §4 step 4, decision Q28; E-09). Pure.
//
// The page reader flags a block that runs off the bottom of a page
// (`continues`) and a block at the top of a page that carries on from the
// previous one (`continued_from`). Each flagged pair is re-read once with both
// page images; the joined block replaces the two halves and is placed by the
// page it starts on. A flag without a partner is never guessed at: the block
// stays as read, flagged.
import type { Block, PageReading } from "../reading/blocks.ts";

export interface Pair {
  /** The last block of the earlier page. */
  first: Block;
  /** The first block of the next page. */
  second: Block;
}

export interface Join {
  /** Ids of the two halves, in page order. */
  replaces: readonly [string, string];
  block: Block;
}

export function findPairs(pages: readonly PageReading[]): {
  pairs: Pair[];
  unpaired: Block[];
} {
  const byPage = new Map(pages.map((p) => [p.pdf_page, p]));
  const pairs: Pair[] = [];
  const paired = new Set<string>();

  for (const page of [...pages].sort((a, b) => a.pdf_page - b.pdf_page)) {
    const first = page.blocks.at(-1);
    const second = byPage.get(page.pdf_page + 1)?.blocks[0];
    // A block already joined to the page before it isn't joined again: a block
    // spanning three pages keeps its first join and its last half stays flagged.
    if (first?.continues && second?.continued_from && !paired.has(first.id)) {
      pairs.push({ first, second });
      paired.add(first.id).add(second.id);
    }
  }

  const unpaired = pages
    .flatMap((page) => page.blocks)
    .filter(
      (block) =>
        !paired.has(block.id) && (block.continues || block.continued_from),
    );
  return { pairs, unpaired };
}

/** Pages with each join applied: the joined block in the first half's place, the second half gone. */
export function applyJoins(
  pages: readonly PageReading[],
  joins: readonly Join[],
): PageReading[] {
  const replacement = new Map<string, Block | null>();
  for (const join of joins) {
    const [first, second] = join.replaces;
    replacement.set(first, {
      ...join.block,
      id: first,
      continues: false,
      continued_from: false,
      continues_on: join.block.pdf_page + 1,
    });
    replacement.set(second, null);
  }
  return pages.map((page) => ({
    ...page,
    blocks: page.blocks.flatMap((block) => {
      const replaced = replacement.get(block.id);
      if (replaced === undefined) return [block];
      return replaced === null
        ? []
        : [{ ...replaced, pdf_page: block.pdf_page, order: block.order }];
    }),
  }));
}
