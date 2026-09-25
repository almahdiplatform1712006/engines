// Page rendering (spec #1 §4 step 1). poppler runs as a separate process, never
// through native bindings (spec §5): `pdftoppm`, falling back to `pdftocairo`,
// which copes with some scans (JBIG2/JPX from phone scanner apps) that
// pdftoppm renders badly or not at all.
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";

const run = promisify(execFile);
const TIMEOUT_MS = 120_000;
export const DPI = 200;

export interface RenderedPage {
  png: Buffer;
  width: number;
  height: number;
}

/** Number of pages in a PDF, from `pdfinfo`. Throws for a file that isn't a PDF. */
export async function pageCount(pdfPath: string): Promise<number> {
  const { stdout } = await run("pdfinfo", [pdfPath], { timeout: TIMEOUT_MS });
  const match = /^Pages:\s+(\d+)/m.exec(stdout);
  if (!match?.[1])
    throw new Error(`pdfinfo found no page count for ${pdfPath}`);
  return Number(match[1]);
}

/** One PDF page as a PNG at ~200 DPI. */
export async function renderPage(
  pdfPath: string,
  pdfPage: number,
): Promise<RenderedPage> {
  const dir = await mkdtemp(join(tmpdir(), "engines-render-"));
  try {
    const out = join(dir, "page");
    const args = [
      "-png",
      "-r",
      String(DPI),
      "-f",
      String(pdfPage),
      "-l",
      String(pdfPage),
      "-singlefile",
      pdfPath,
      out,
    ];
    try {
      await run("pdftoppm", args, { timeout: TIMEOUT_MS });
      return await described(await readFile(`${out}.png`));
    } catch (first) {
      try {
        await run("pdftocairo", args, { timeout: TIMEOUT_MS });
        return await described(await readFile(`${out}.png`));
      } catch (second) {
        throw new Error(
          `could not render page ${String(pdfPage)}: pdftoppm: ${String(first)}; pdftocairo: ${String(second)}`,
          { cause: second },
        );
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** A photo of a page (one page per photo) as an upright PNG, capped in size. */
export async function normalisePhoto(bytes: Uint8Array): Promise<RenderedPage> {
  const png = await sharp(bytes)
    .rotate() // honour EXIF orientation
    .resize({
      width: 2400,
      height: 3400,
      fit: "inside",
      withoutEnlargement: true,
    })
    .png()
    .toBuffer();
  return described(png);
}

async function described(png: Buffer): Promise<RenderedPage> {
  const { width, height } = await sharp(png).metadata();
  return { png, width, height };
}
