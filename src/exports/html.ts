// The worksheet as one self-contained HTML page: right-to-left for Arabic, the
// Arabic font embedded, math as MathML (Temml), figures inline. Chromium prints
// it to PDF (pdf.ts).
import { readFile } from "node:fs/promises";
import type { StoredImage } from "../assembly/result.ts";
import { splitMath } from "../shared/latex.ts";
import { escapeHtml, toMathML } from "./math.ts";
import type { Entry, Worksheet } from "./worksheet.ts";

const FONT_URL = new URL(
  "../../assets/fonts/NotoNaskhArabic.ttf",
  import.meta.url,
);

const LABELS = {
  ar: { answers: "مفتاح الإجابات", question: "السؤال" },
  en: { answers: "Answer key", question: "Question" },
} as const;

/** `images` maps a stored image's key to its PNG bytes. */
export async function worksheetHtml(
  worksheet: Worksheet,
  images: ReadonlyMap<string, Buffer>,
): Promise<string> {
  const font = (await readFile(FONT_URL)).toString("base64");
  const labels = LABELS[worksheet.lang];
  const body = worksheet.sections
    .map((section) => {
      const level = Math.min(section.depth + 1, 4);
      return `<section>
<h${String(level)}>${escapeHtml(section.heading)}</h${String(level)}>
${section.entries.map((entry) => entryHtml(entry, images)).join("\n")}
</section>`;
    })
    .join("\n");
  const key = worksheet.answerKey
    .map(
      (a) => `<li value="${String(a.number)}">${inline(a.answer, false)}</li>`,
    )
    .join("");

  return `<!doctype html>
<html lang="${worksheet.lang}" dir="${worksheet.rtl ? "rtl" : "ltr"}">
<head>
<meta charset="utf-8">
<title>${escapeHtml(worksheet.title)}</title>
<style>
@font-face { font-family: "Noto Naskh Arabic"; src: url(data:font/ttf;base64,${font}) format("truetype"); }
@page { size: A4; margin: 18mm 16mm; }
body { font-family: "Noto Naskh Arabic", "DejaVu Sans", sans-serif; font-size: 12pt; line-height: 1.7; color: #111; }
h1 { font-size: 20pt; margin-block: 0 12pt; }
h2 { font-size: 16pt; margin-block: 18pt 6pt; border-block-end: 1px solid #999; }
h3, h4 { font-size: 13pt; margin-block: 12pt 4pt; }
section { break-inside: auto; }
.stimulus { border: 1px solid #bbb; border-radius: 4pt; padding: 6pt 10pt; margin-block: 8pt; background: #f7f7f7; }
.question { margin-block: 8pt; break-inside: avoid; }
.question .number { font-weight: bold; margin-inline-end: 6pt; }
.options { list-style: none; padding-inline-start: 18pt; margin-block: 2pt; }
.options li { margin-block: 1pt; }
.explanation { margin-block: 8pt; }
img { max-width: 100%; max-height: 90mm; display: block; margin-block: 4pt; }
math { font-size: 1.05em; }
table { border-collapse: collapse; margin-block: 6pt; }
td, th { border: 1px solid #999; padding: 2pt 6pt; }
.answers { break-before: page; }
.answers ol { columns: 3; }
</style>
</head>
<body>
<h1>${escapeHtml(worksheet.title)}</h1>
${body}
<section class="answers"><h2>${labels.answers}</h2><ol>${key}</ol></section>
</body>
</html>`;
}

function entryHtml(entry: Entry, images: ReadonlyMap<string, Buffer>): string {
  if (entry.kind === "stimulus") {
    const s = entry.stimulus;
    return `<div class="stimulus">${s.text ? paragraphs(s.text, false) : ""}${image(s.image, images)}</div>`;
  }
  if (entry.kind === "question") {
    const q = entry.question;
    const rtl = q.math_direction === "rtl";
    const options = q.options.length
      ? `<ul class="options">${q.options.map((o) => `<li>${escapeHtml(o.key)}) ${inline(o.text, rtl)}</li>`).join("")}</ul>`
      : "";
    return `<div class="question"><span class="number">${String(entry.number)}.</span>${inline(q.text, rtl)}${image(q.image, images)}${options}</div>`;
  }
  const c = entry.chunk;
  const rtl = c.math_direction === "rtl";
  return `<div class="explanation"><h4>${escapeHtml(c.heading)}</h4>${markdown(c.markdown, rtl)}${c.figures.map((f) => image(f, images)).join("")}</div>`;
}

function image(
  stored: StoredImage | null,
  images: ReadonlyMap<string, Buffer>,
): string {
  const bytes = stored?.key ? images.get(stored.key) : undefined;
  return bytes
    ? `<img alt="" src="data:image/png;base64,${bytes.toString("base64")}">`
    : "";
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

function paragraphs(text: string, rtlMath: boolean): string {
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
