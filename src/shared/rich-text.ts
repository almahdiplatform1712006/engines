// Text as HTML: Engines' small Markdown (paragraphs, `###` headings, tables,
// **bold**) with math as MathML through Temml (`dir="rtl"` where the book
// writes math right-to-left). The exports and the page's review both use it,
// so math looks the same in both. Math is copied exactly as printed.
import temml from "temml";
import { splitMath } from "./math-spans.ts";

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

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${String(c.charCodeAt(0))};`);
}

/** Text with its math spans as MathML. */
export function inline(text: string, rtlMath: boolean): string {
  return splitMath(text)
    .map((piece) =>
      piece.kind === "text"
        ? escapeHtml(piece.text).replace(
            /\*\*(.+?)\*\*/g,
            "<strong>$1</strong>",
          )
        : toMathML(piece.tex, { display: piece.display, rtl: rtlMath }),
    )
    .join("");
}

/** Plain paragraphs, with math. */
export function paragraphs(text: string, rtlMath: boolean): string {
  return text
    .split(/\n\s*\n/)
    .filter((p) => p.trim() !== "")
    .map((p) => `<p>${inline(p, rtlMath).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

/**
 * The small Markdown explanation chunks use: paragraphs, `###` headings,
 * tables and math. The breadcrumb line each chunk starts with is left out:
 * the worksheet's own headings already say where it is.
 */
export function markdown(md: string, rtlMath: boolean): string {
  return md
    .split(/\n\s*\n/)
    .filter((block) => block.trim() !== "" && !block.startsWith("> "))
    .map((block) => {
      const heading = /^(#{1,6})\s+(.*)$/.exec(block.trim());
      if (heading?.[2] !== undefined)
        return `<h4>${inline(heading[2], rtlMath)}</h4>`;
      if (block.trimStart().startsWith("|")) return table(block, rtlMath);
      return paragraphs(block, rtlMath);
    })
    .join("");
}

function table(block: string, rtlMath: boolean): string {
  const rows = block
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("|") && !/^\|[\s:|-]+\|$/.test(line))
    .map((line) =>
      line
        .replace(/^\||\|$/g, "")
        .split("|")
        .map((cell) => `<td>${inline(cell.trim(), rtlMath)}</td>`)
        .join(""),
    );
  return `<table>${rows.map((r) => `<tr>${r}</tr>`).join("")}</table>`;
}
