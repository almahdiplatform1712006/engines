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
