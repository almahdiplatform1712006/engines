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

  override requestDataRange(begin: number, end: number): void {
    this.read(begin, end).then(
      (chunk) => {
        this.onDataRange(begin, new Uint8Array(chunk));
      },
      () => {
        this.abort();
      },
    );
  }
}

/** The PDF's page count, or null when pdf.js can't read it (poppler decides at render). */
export async function countPdfPages(
  store: BlobStore,
  key: string,
  size: number,
): Promise<number | null> {
  const task = getDocument({
    range: new StoreRanges(size, (begin, end) =>
      store.readRange(key, begin, end),
    ),
    rangeChunkSize: 256 * 1024,
    disableAutoFetch: true,
    disableStream: true,
    verbosity: 0,
  });
  try {
    const doc = await task.promise;
    return doc.numPages;
  } catch {
    return null;
  } finally {
    await task.destroy();
  }
}
