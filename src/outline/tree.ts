// The rules a syllabus tree must meet before it can run a document (spec #1 §1
// step 3). Pure, so the API and the page's editor report the same issues.
import type {
  OutlineIssue,
  OutlineNode,
  OutlineNodeInput,
} from "../contract/outline.ts";
import { newId } from "../shared/ids.ts";

export interface Validation {
  /** Block confirmation. */
  errors: OutlineIssue[];
  /** Shown, never blocking. */
  warnings: OutlineIssue[];
}

export function validateOutline(nodes: readonly OutlineNode[]): Validation {
  const errors: OutlineIssue[] = [];
  const warnings: OutlineIssue[] = [];
  const seen = new Set<string>();
  let answerKeys = 0;

  const visit = (
    siblings: readonly OutlineNode[],
    parent: OutlineNode | null,
  ) => {
    for (const node of siblings) {
      if (seen.has(node.id)) {
        errors.push(
          issue("duplicate_id", node, `Node id "${node.id}" is used twice.`),
        );
      }
      seen.add(node.id);

      if (node.kind === "answer_key" && ++answerKeys > 1) {
        errors.push(
          issue(
            "multiple_answer_keys",
            node,
            "Only one answer-key node is allowed.",
          ),
        );
      }

      const range = node.printed_pages;
      if (range === null) {
        errors.push(
          issue(
            "missing_range",
            node,
            `"${node.name}" needs a printed page range.`,
          ),
        );
      } else if (range.from > range.to) {
        errors.push(
          issue(
            "inverted_range",
            node,
            `"${node.name}" starts on page ${String(range.from)} after it ends on ${String(range.to)}.`,
          ),
        );
      } else if (
        parent?.printed_pages &&
        (range.from < parent.printed_pages.from ||
          range.to > parent.printed_pages.to)
      ) {
        errors.push(
          issue(
            "outside_parent",
            node,
            `"${node.name}" (${span(range)}) is outside "${parent.name}" (${span(parent.printed_pages)}).`,
          ),
        );
      }
    }

    checkSiblings(siblings, errors, warnings);
    for (const node of siblings) visit(node.children, node);
  };

  visit(nodes, null);
  return { errors, warnings };
}

/** Siblings, in page order, may share one boundary page. Wider overlaps are errors, gaps are warnings. */
function checkSiblings(
  siblings: readonly OutlineNode[],
  errors: OutlineIssue[],
  warnings: OutlineIssue[],
): void {
  const ranged = siblings
    .filter(
      (n) =>
        n.printed_pages !== null && n.printed_pages.from <= n.printed_pages.to,
    )
    .sort(
      (a, b) => (a.printed_pages?.from ?? 0) - (b.printed_pages?.from ?? 0),
    );

  for (let i = 1; i < ranged.length; i++) {
    const before = ranged[i - 1];
    const node = ranged[i];
    if (!before?.printed_pages || !node?.printed_pages) continue;
    const end = before.printed_pages.to;
    const start = node.printed_pages.from;
    if (start < end) {
      errors.push(
        issue(
          "sibling_overlap",
          node,
          `"${node.name}" (${span(node.printed_pages)}) overlaps "${before.name}" (${span(before.printed_pages)}) by more than one page.`,
        ),
      );
    } else if (start > end + 1) {
      warnings.push(
        issue(
          "gap",
          node,
          `Pages ${span({ from: end + 1, to: start - 1 })} between "${before.name}" and "${node.name}" belong to their parent.`,
        ),
      );
    }
  }
}

/** Fills defaults for nodes a client sent, keeping ids it chose and minting the rest. */
export function normaliseTree(
  nodes: readonly OutlineNodeInput[],
): OutlineNode[] {
  return nodes.map((input) => ({
    id: input.id ?? newId("n", 10),
    name: input.name.trim(),
    level: input.level ?? null,
    printed_pages: input.printed_pages ?? null,
    kind: input.kind ?? "content",
    external_ref: input.external_ref ?? null,
    children: normaliseTree(input.children ?? []),
  }));
}

/** Every node with its ancestors' names, depth first in tree order. */
export function* walk(
  nodes: readonly OutlineNode[],
  path: readonly OutlineNode[] = [],
): Generator<{ node: OutlineNode; ancestors: readonly OutlineNode[] }> {
  for (const node of nodes) {
    yield { node, ancestors: path };
    yield* walk(node.children, [...path, node]);
  }
}

function issue(
  code: OutlineIssue["code"],
  node: OutlineNode,
  message: string,
): OutlineIssue {
  return { code, node_id: node.id, message };
}

function span(range: { from: number; to: number }): string {
  return range.from === range.to
    ? `p. ${String(range.from)}`
    : `pp. ${String(range.from)}–${String(range.to)}`;
}
