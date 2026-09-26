// PDF page labels (the "i, ii, 1, 2 …" a publisher may set), read with pdf.js.
// Extra evidence for the offset fit (E-07); scans rarely have them. Only the
// labels are read, never the text layer (spec §5 excludes it for Arabic).
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

/** One label per PDF page, or null when the file sets none. */
export async function pageLabels(
  pdf: Uint8Array,
): Promise<(string | null)[] | null> {
  const task = getDocument({
    data: new Uint8Array(pdf),
    verbosity: 0,
  });
  try {
    const doc = await task.promise;
    const labels = await doc.getPageLabels();
    return labels?.map((label) => (label === "" ? null : label)) ?? null;
  } catch {
    return null;
  } finally {
    await task.destroy();
  }
}
