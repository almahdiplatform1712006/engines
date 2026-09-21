// Every golden-set score is kept as a numerator and denominator rather than a
// finished fraction, so scores for single pages add up into a book or run total
// without averaging averages.
export interface Ratio {
  num: number;
  den: number;
}

export const EMPTY: Ratio = { num: 0, den: 0 };

export function add(a: Ratio, b: Ratio): Ratio {
  return { num: a.num + b.num, den: a.den + b.den };
}

/** The ratio's value, or null when nothing was measured. */
export function value(ratio: Ratio): number | null {
  return ratio.den === 0 ? null : ratio.num / ratio.den;
}
