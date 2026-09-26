// The editor holds the tree flat (id → node and its children's ids), which is
// what Headless Tree reads and drag-and-drop rewrites; the API and the shared
// validation take it nested.
import type { OutlineNode } from "../../src/contract/outline.ts";
import { newId } from "../../src/shared/ids.ts";

export const ROOT = "root";

export type NodeFields = Omit<OutlineNode, "children">;

export interface FlatTree {
  /** Every node's fields, by id; ROOT has none. */
  fields: Record<string, NodeFields>;
  /** Children in order, by parent id (ROOT for the top level). */
  children: Record<string, string[]>;
}

export function flatten(nodes: readonly OutlineNode[]): FlatTree {
  const tree: FlatTree = { fields: {}, children: { [ROOT]: [] } };
  const visit = (parent: string, list: readonly OutlineNode[]) => {
    for (const { children, ...fields } of list) {
      tree.fields[fields.id] = fields;
      tree.children[fields.id] = [];
      tree.children[parent]?.push(fields.id);
      visit(fields.id, children);
    }
  };
  visit(ROOT, nodes);
  return tree;
}

export function nest(tree: FlatTree, parent = ROOT): OutlineNode[] {
  return (tree.children[parent] ?? []).flatMap((id) => {
    const fields = tree.fields[id];
    return fields ? [{ ...fields, children: nest(tree, id) }] : [];
  });
}

export function updateNode(
  tree: FlatTree,
  id: string,
  change: Partial<NodeFields>,
): FlatTree {
  const fields = tree.fields[id];
  if (!fields) return tree;
  return {
    ...tree,
    fields: { ...tree.fields, [id]: { ...fields, ...change } },
  };
}

/** A new empty node at the end of `parent`'s children; returns the tree and its id. */
export function addNode(
  tree: FlatTree,
  parent: string,
  fields: Partial<NodeFields> = {},
): { tree: FlatTree; id: string } {
  const id = newId("n", 10);
  return {
    id,
    tree: {
      fields: {
        ...tree.fields,
        [id]: {
          id,
          name: "",
          level: null,
          printed_pages: null,
          kind: "content",
          external_ref: null,
          ...fields,
        },
      },
      children: {
        ...tree.children,
        [id]: [],
        [parent]: [...(tree.children[parent] ?? []), id],
      },
    },
  };
}

/** Removes a node and everything under it. */
export function removeNode(tree: FlatTree, id: string): FlatTree {
  const gone = new Set<string>();
  const collect = (node: string) => {
    gone.add(node);
    for (const child of tree.children[node] ?? []) collect(child);
  };
  collect(id);
  const fields = Object.fromEntries(
    Object.entries(tree.fields).filter(([key]) => !gone.has(key)),
  );
  const children = Object.fromEntries(
    Object.entries(tree.children)
      .filter(([key]) => !gone.has(key))
      .map(([key, list]) => [key, list.filter((c) => !gone.has(c))]),
  );
  return { fields, children };
}

/** Drag-and-drop's result: `parent`'s children, in their new order. */
export function setChildren(
  tree: FlatTree,
  parent: string,
  ids: string[],
): FlatTree {
  // A moved node leaves its old parent.
  const moved = new Set(ids);
  const children = Object.fromEntries(
    Object.entries(tree.children).map(([key, list]) => [
      key,
      key === parent ? ids : list.filter((c) => !moved.has(c)),
    ]),
  );
  return { ...tree, children };
}

export function parentOf(tree: FlatTree, id: string): string | null {
  for (const [parent, list] of Object.entries(tree.children)) {
    if (list.includes(id)) return parent;
  }
  return null;
}
