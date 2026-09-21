// npm run golden:draft -- <book> [--force]
// npm run golden:sheet -- <book>
// npm run golden:score -- [<book> …] [--baseline <run.json>]
// npm run golden:score -- --compare <a.json> <b.json>
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { bookPaths, exists, readJson } from "./book.ts";
import { draftBook } from "./draft.ts";
import { selectReader } from "./reader.ts";
import {
  formatComparison,
  formatRun,
  Run,
  scoreBooks,
  writeRun,
} from "./score.ts";
import { writeCorrectionSheet } from "./sheet.ts";
import type { PageFailure } from "./truth.ts";

const ROOT = fileURLToPath(new URL("../../golden/", import.meta.url));

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case "draft":
      return draft(rest);
    case "sheet":
      return sheet(rest);
    case "score":
      return score(rest);
    default:
      throw new Error(
        `unknown command "${command ?? ""}": expected draft, sheet or score`,
      );
  }
}

async function draft(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { force: { type: "boolean", default: false } },
  });
  const book = onlyBook(positionals);
  const reader = selectReader(process.env);
  const report = await draftBook({
    root: ROOT,
    book,
    reader,
    force: values.force,
  });

  console.log(`reader: ${reader.name}`);
  console.log(`drafted: ${report.written.join(", ") || "none"}`);
  console.log(
    `kept (already drafted or corrected): ${report.kept.join(", ") || "none"}`,
  );
  report.failures.forEach((failure) => {
    printFailure(book, failure);
  });
  console.log(`correction sheet: ${await writeCorrectionSheet(ROOT, book)}`);
  return report.failures.length === 0 ? 0 : 1;
}

async function sheet(args: string[]): Promise<number> {
  const { positionals } = parseArgs({ args, allowPositionals: true });
  console.log(await writeCorrectionSheet(ROOT, onlyBook(positionals)));
  return 0;
}

async function score(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      compare: { type: "boolean", default: false },
      baseline: { type: "string" },
    },
  });

  if (values.compare) {
    const [a, b, ...extra] = positionals;
    if (a === undefined || b === undefined || extra.length > 0) {
      throw new Error(
        "--compare takes exactly two run files: --compare <a.json> <b.json>",
      );
    }
    console.log(formatComparison(await loadRun(a), await loadRun(b)));
    return 0;
  }

  const books = positionals.length > 0 ? positionals : await allBooks();
  if (books.length === 0)
    throw new Error(`no books with a manifest.json in ${ROOT}`);
  const run = await scoreBooks({
    root: ROOT,
    books,
    reader: selectReader(process.env),
  });

  console.log(formatRun(run));
  run.failures.forEach((failure) => {
    printFailure(failure.book, failure);
  });
  console.log(`\nwrote ${await writeRun(ROOT, run)}`);
  if (values.baseline !== undefined) {
    console.log(`\n${formatComparison(await loadRun(values.baseline), run)}`);
  }
  return run.failures.length === 0 ? 0 : 1;
}

function printFailure(book: string, failure: PageFailure): void {
  const detail = failure.detail === undefined ? "" : `: ${failure.detail}`;
  console.log(`failed: ${book}/${failure.page} — ${failure.reason}${detail}`);
}

function onlyBook(positionals: string[]): string {
  const [book, ...extra] = positionals;
  if (book === undefined || extra.length > 0)
    throw new Error("give exactly one book id");
  return book;
}

async function allBooks(): Promise<string[]> {
  const entries = await readdir(ROOT, { withFileTypes: true });
  const books: string[] = [];
  for (const entry of entries) {
    if (
      entry.isDirectory() &&
      (await exists(bookPaths(ROOT, entry.name).manifest))
    )
      books.push(entry.name);
  }
  return books.sort();
}

function loadRun(path: string): Promise<Run> {
  return readJson(path, Run, "run file");
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 2;
}
