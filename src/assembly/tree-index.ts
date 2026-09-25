// Page-range lookups over a confirmed outline. Placement is plain code (hard
// rule 4): the node for a page is decided here, never by the model.
import type { OutlineNode } from "../contract/outline.ts";

export interface IndexedNode {
  node: OutlineNode;
  /** Names from the root to this node, inclusive. */
  path: string[];
  ancestors: OutlineNode[];
  depth: number;
  from: number;
  to: number;
}

export interface TreeIndex {
  nodes: IndexedNode[];
  byId: Map<string, IndexedNode>;
  /** The deepest nodes whose range contains the printed page (two on a shared page). */
  deepest(printed: number): IndexedNode[];
}

export function indexTree(tree: readonly OutlineNode[]): TreeIndex {
  const nodes: IndexedNode[] = [];
  const visit = (list: readonly OutlineNode[], ancestors: OutlineNode[]) => {
    for (const node of list) {
      const range = node.printed_pages;
      if (range) {
        nodes.push({
          node,
          path: [...ancestors.map((a) => a.name), node.name],
          ancestors,
          depth: ancestors.length,
          from: range.from,
          to: range.to,
        });
      }
      visit(node.children, [...ancestors, node]);
    }
  };
  visit(tree, []);
  const byId = new Map(nodes.map((n) => [n.node.id, n]));

  return {
    nodes,
    byId,
    deepest(printed) {
      const containing = nodes.filter(
        (n) => printed >= n.from && printed <= n.to,
      );
      // A node is deepest when none of its descendants also contains the page.
      return containing.filter(
        (candidate) =>
          !containing.some((other) => other.ancestors.includes(candidate.node)),
      );
    },
  };
}
