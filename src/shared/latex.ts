// Math in Engines is LaTeX inside $…$, $$…$$, \(…\) or \[…\], checked with KaTeX
// (`throwOnError`), as spec §4 step 9 asks.
import katex from "katex";
import { mathSpans, type MathSpan } from "./math-spans.ts";

export {
  mathSpans,
  splitMath,
  type MathSpan,
  type Piece,
} from "./math-spans.ts";

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
