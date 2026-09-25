// Counts a stored PDF's pages without downloading it (E-14): pdf.js asks for
// byte ranges (the cross-reference table, the catalog, the page tree) and
// storage serves only those. The count is known at `POST /v1/documents`, so a
// book over the limit or the balance is refused before anything is queued.
import {
  getDocument,
  PDFDataRangeTransport,
} from "pdfjs-dist/legacy/build/pdf.mjs";
import type { BlobStore } from "../storage/store.ts";

class StoreRanges extends PDFDataRangeTransport {
  private readonly read: (begin: number, end: number) => Promise<Buffer>;

  constructor(
    length: number,
    read: (begin: number, end: number) => Promise<Buffer>,
  ) {
    super(length, null);
    this.read = read;
  }

  /** Set when a range can't be read; pdf.js's own abort does nothing. */
  onFailure: (error: unknown) => void = () => undefined;

  override requestDataRange(begin: number, end: number): void {
    this.read(begin, end).then(
      (chunk) => {
        this.onDataRange(begin, new Uint8Array(chunk));
      },
      (error: unknown) => {
        this.onFailure(error);
      },
    );
  }
}

/** Give up on pdf.js after this long; the caller falls back to poppler. */
const TIMEOUT_MS = 30_000;

/** The PDF's page count, or null when pdf.js can't read it in time. */
export async function countPdfPages(
  store: BlobStore,
  key: string,
  size: number,
): Promise<number | null> {
  const ranges = new StoreRanges(size, (begin, end) =>
    store.readRange(key, begin, end),
  );
  const task = getDocument({
    range: ranges,
    rangeChunkSize: 256 * 1024,
    disableAutoFetch: true,
    disableStream: true,
    verbosity: 0,
  });
  let timer: NodeJS.Timeout | undefined;
  const failed = new Promise<null>((resolve) => {
    ranges.onFailure = () => {
      resolve(null);
    };
    timer = setTimeout(() => {
      resolve(null);
    }, TIMEOUT_MS);
  });
  try {
    return await Promise.race([
      task.promise.then((doc) => doc.numPages).catch(() => null),
      failed,
    ]);
  } finally {
    clearTimeout(timer);
    await task.destroy();
  }
}
