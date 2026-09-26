import type { OutlineNode } from "../src/contract/outline.ts";

/** An outline node for tests: `n("l1", 3, 9, [children])`. */
export function n(
  id: string,
  from: number,
  to: number,
  children: OutlineNode[] = [],
  fields: Partial<OutlineNode> = {},
): OutlineNode {
  return {
    id,
    name: id,
    level: null,
    printed_pages: { from, to },
    kind: "content",
    external_ref: null,
    children,
    ...fields,
  };
}
