// Where the math is in a text: LaTeX inside $…$, $$…$$, \(…\) or \[…\].
// Plain code with no dependencies, so the page can use it too.
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
