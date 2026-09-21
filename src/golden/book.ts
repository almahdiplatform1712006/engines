// Where a golden book's files live, and reading them back through the schemas.
//
//   golden/<book>/manifest.json         committed
//   golden/<book>/truth/<page_id>.json  committed
//   golden/<book>/images/<file>         never committed (copyright)
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { BookManifest, PageTruth } from "./truth.ts";

const BYTE_ORDER_MARK = String.fromCodePoint(0xfeff);

export interface BookPaths {
  dir: string;
  manifest: string;
  images: string;
  truthDir: string;
  truth: (pageId: string) => string;
  sheet: string;
}

export function bookPaths(root: string, book: string): BookPaths {
  const dir = join(root, book);
  return {
    dir,
    manifest: join(dir, "manifest.json"),
    images: join(dir, "images"),
    truthDir: join(dir, "truth"),
    truth: (pageId) => join(dir, "truth", `${pageId}.json`),
    sheet: join(dir, "sheet.html"),
  };
}

export async function loadManifest(
  root: string,
  book: string,
): Promise<BookManifest> {
  const path = bookPaths(root, book).manifest;
  const manifest = await readJson(path, BookManifest, "manifest");
  if (manifest.book !== book) {
    throw new Error(
      `${path}: manifest is for book "${manifest.book}", not "${book}"`,
    );
  }
  return manifest;
}

/** The page's truth file, or null when it hasn't been drafted yet. */
export async function loadTruth(
  root: string,
  book: string,
  pageId: string,
): Promise<PageTruth | null> {
  const path = bookPaths(root, book).truth(pageId);
  if (!(await exists(path))) return null;
  return readJson(path, PageTruth, "truth file");
}

export async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Reads a JSON file and checks it against a schema, naming the file in any error. */
export async function readJson<T extends z.ZodType>(
  path: string,
  schema: T,
  what: string,
): Promise<z.output<T>> {
  let raw: unknown;
  try {
    // Windows editors often save UTF-8 with a byte-order mark, which JSON.parse rejects.
    const text = await readFile(path, "utf8");
    raw = JSON.parse(text.startsWith(BYTE_ORDER_MARK) ? text.slice(1) : text);
  } catch (error) {
    throw new Error(
      `${path}: not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new Error(
      `${path}: not a valid ${what}:\n${z.prettifyError(result.error)}`,
    );
  }
  return result.data;
}
