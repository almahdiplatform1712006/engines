// A cap on model calls in flight from one worker (E-13), separate from the
// per-key document cap. With N workers, the provider sees at most N × limit.
import type { PageReader } from "./reader.ts";

/** One cap shared by every reader it wraps (every provider's, in a worker). */
export function callLimiter(limit: number): (reader: PageReader) => PageReader {
  let active = 0;
  const waiting: (() => void)[] = [];
  const run = async <T>(call: () => Promise<T>): Promise<T> => {
    if (active >= limit)
      await new Promise<void>((resolve) => waiting.push(resolve));
    active++;
    try {
      return await call();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
  return (reader) => ({
    readPrintedNumber: (...args) =>
      run(() => reader.readPrintedNumber(...args)),
    readPage: (...args) => run(() => reader.readPage(...args)),
    readPair: (...args) => run(() => reader.readPair(...args)),
    solve: (...args) => run(() => reader.solve(...args)),
  });
}
