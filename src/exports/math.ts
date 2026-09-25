// Math for exports (spec #1 §5 Math): LaTeX → MathML with Temml for HTML and
// PDF (`dir="rtl"` where the book writes math right-to-left), and MathML →
// Word's own equations (OMML, through the docx library) so math in a .docx
// stays editable. Math is copied exactly as printed, never translated.
import {
  MathFraction,
  MathRadical,
  MathRun,
  MathSubScript,
  MathSubSuperScript,
  MathSuperScript,
  type MathComponent,
} from "docx";
import { XMLParser } from "fast-xml-parser";
import temml from "temml";

export function toMathML(
  tex: string,
  options: { display: boolean; rtl: boolean },
): string {
  try {
    const mathml = temml.renderToString(tex, {
      displayMode: options.display,
      throwOnError: true,
    });
    return options.rtl ? mathml.replace(/^<math/, '<math dir="rtl"') : mathml;
  } catch {
    // The checks flagged it already (latex_invalid); show the source rather than lose it.
    return `<code dir="ltr">${escapeHtml(tex)}</code>`;
  }
}

type Node = Record<string, unknown>;

const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: true,
  trimValues: false,
});

/** Word equation parts for a LaTeX span; its source as plain math text when it can't be read. */
export function toWordMath(tex: string): MathComponent[] {
  let tree: Node[];
  try {
    tree = parser.parse(
      temml.renderToString(tex, { throwOnError: true }),
    ) as Node[];
  } catch {
    return [new MathRun(tex)];
  }
  const math = tree.find((n) => "math" in n);
  return math ? convert(children(math, "math")) : [new MathRun(tex)];
}

function children(node: Node, tag: string): Node[] {
  const value = node[tag];
  return Array.isArray(value) ? (value as Node[]) : [];
}

function tagOf(node: Node): string | undefined {
  return Object.keys(node).find((k) => k !== ":@");
}

function textOf(nodes: Node[]): string {
  return nodes
    .map((n) => {
      const tag = tagOf(n);
      if (tag === "#text") return String(n["#text"]);
      return tag ? textOf(children(n, tag)) : "";
    })
    .join("");
}

function convert(nodes: Node[]): MathComponent[] {
  return nodes.flatMap((node) => convertOne(node));
}

function convertOne(node: Node): MathComponent[] {
  const tag = tagOf(node);
  if (tag === undefined) return [];
  if (tag === "#text") return [new MathRun(String(node["#text"]))];
  const kids = children(node, tag).filter((k) => tagOf(k) !== "annotation");
  const arg = (i: number) => convert(kids[i] ? [kids[i]] : []);
  switch (tag) {
    case "mi":
    case "mn":
    case "mo":
    case "mtext":
    case "ms":
      return [new MathRun(textOf(kids))];
    case "mfrac":
      return [new MathFraction({ numerator: arg(0), denominator: arg(1) })];
    case "msup":
      return [new MathSuperScript({ children: arg(0), superScript: arg(1) })];
    case "msub":
      return [new MathSubScript({ children: arg(0), subScript: arg(1) })];
    case "msubsup":
      return [
        new MathSubSuperScript({
          children: arg(0),
          subScript: arg(1),
          superScript: arg(2),
        }),
      ];
    case "msqrt":
      return [new MathRadical({ children: convert(kids) })];
    case "mroot":
      return [new MathRadical({ children: arg(0), degree: arg(1) })];
    case "munder":
      return [new MathSubScript({ children: arg(0), subScript: arg(1) })];
    case "mover":
      return [new MathSuperScript({ children: arg(0), superScript: arg(1) })];
    case "munderover":
      return [
        new MathSubSuperScript({
          children: arg(0),
          subScript: arg(1),
          superScript: arg(2),
        }),
      ];
    default:
      // mrow, mstyle, mpadded, semantics…: their content, in order.
      return convert(kids);
  }
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${String(c.charCodeAt(0))};`);
}
