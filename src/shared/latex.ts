// Math in Engines is LaTeX inside $…$, $$…$$, \(…\) or \[…\], checked with KaTeX
// (`throwOnError`), as spec §4 step 9 asks.
import katex from "katex";

const MATH_SPAN =
  /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|(?<!\\)\$((?:\\\$|[^$])+?)(?<!\\)\$/g;

export interface MathSpan {
  tex: string;
  display: boolean;
}

export function mathSpans(text: string): MathSpan[] {
  return [...text.matchAll(MATH_SPAN)].map((match) => {
    const [, display, bracket, paren, inline] = match;
    return {
      tex: display ?? bracket ?? paren ?? inline ?? "",
      display: display !== undefined || bracket !== undefined,
    };
  });
}

export function parsesInKatex(span: MathSpan): boolean {
  try {
    // strict: false only silences KaTeX's style warnings (such as Arabic outside \text); parse errors still throw.
    katex.renderToString(span.tex, {
      throwOnError: true,
      displayMode: span.display,
      strict: false,
    });
    return true;
  } catch {
    return false;
  }
}

/** Whether every math span in the text parses. */
export function latexValid(text: string): boolean {
  return mathSpans(text).every(parsesInKatex);
}

export type Piece =
  | { kind: "text"; text: string }
  | { kind: "math"; tex: string; display: boolean };

/** Text cut into plain runs and math spans, in order. */
export function splitMath(text: string): Piece[] {
  const pieces: Piece[] = [];
  let at = 0;
  for (const match of text.matchAll(MATH_SPAN)) {
    const [whole, display, bracket, paren, inline] = match;
    const index = match.index;
    if (index > at) pieces.push({ kind: "text", text: text.slice(at, index) });
    pieces.push({
      kind: "math",
      tex: display ?? bracket ?? paren ?? inline ?? "",
      display: display !== undefined || bracket !== undefined,
    });
    at = index + whole.length;
  }
  if (at < text.length) pieces.push({ kind: "text", text: text.slice(at) });
  return pieces;
}
