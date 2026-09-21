// Scoring runs: read every corrected golden page with the current page reader,
// score it, and keep the result as JSON so runs can be compared later.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { bookPaths, exists, loadManifest, loadTruth } from "./book.ts";
import { add, EMPTY, type Ratio, value } from "./ratio.ts";
import type { PageReader } from "./reader.ts";
import {
  correctAnswerAccuracy,
  costPerPage,
  cropIoU,
  explanationCER,
  latexParseRate,
  optionSetExactMatch,
  printedPageAccuracy,
  questionPrecision,
  questionRecall,
  stimulusLinkAccuracy,
} from "./scorers.ts";
import { PageContent, Usage } from "./truth.ts";

interface Metric {
  label: string;
  unit: "percent" | "usd" | "iou";
  lowerIsBetter: boolean;
  score: (truth: PageContent, predicted: PageContent, usage: Usage) => Ratio;
}

export const METRICS = {
  question_recall: {
    label: "question recall",
    unit: "percent",
    lowerIsBetter: false,
    score: questionRecall,
  },
  question_precision: {
    label: "question precision",
    unit: "percent",
    lowerIsBetter: false,
    score: questionPrecision,
  },
  option_set_exact: {
    label: "option-set exact match",
    unit: "percent",
    lowerIsBetter: false,
    score: optionSetExactMatch,
  },
  correct_answer: {
    label: "correct-answer accuracy",
    unit: "percent",
    lowerIsBetter: false,
    score: correctAnswerAccuracy,
  },
  stimulus_link: {
    label: "stimulus-link accuracy",
    unit: "percent",
    lowerIsBetter: false,
    score: stimulusLinkAccuracy,
  },
  crop_iou: {
    label: "crop IoU",
    unit: "iou",
    lowerIsBetter: false,
    score: cropIoU,
  },
  explanation_cer: {
    label: "explanation CER",
    unit: "percent",
    lowerIsBetter: true,
    score: explanationCER,
  },
  latex_parse_rate: {
    label: "LaTeX KaTeX-parse rate",
    unit: "percent",
    lowerIsBetter: false,
    score: (_truth, predicted) => latexParseRate(predicted),
  },
  printed_page: {
    label: "printed-page accuracy",
    unit: "percent",
    lowerIsBetter: false,
    score: printedPageAccuracy,
  },
  cost_per_page_usd: {
    label: "cost per page (USD)",
    unit: "usd",
    lowerIsBetter: true,
    score: (_truth, _predicted, usage) => costPerPage(usage),
  },
} satisfies Record<string, Metric>;

export type MetricName = keyof typeof METRICS;
const METRIC_NAMES = Object.keys(METRICS) as MetricName[];

const RatioSchema = z.object({ num: z.number(), den: z.number() });
const Scores = z.object(
  Object.fromEntries(METRIC_NAMES.map((name) => [name, RatioSchema])) as Record<
    MetricName,
    typeof RatioSchema
  >,
);

/** `golden/runs/<id>.json`: one scoring run, kept so later runs can be compared with it. */
export const Run = z.object({
  id: z.string(),
  created_at: z.string(),
  reader: z.string(),
  totals: Scores,
  pages: z.array(
    z.object({
      book: z.string(),
      page: z.string(),
      scores: Scores,
      usage: Usage,
      prediction: PageContent,
    }),
  ),
  /** Pages in a manifest that were not scored, and why. */
  skipped: z.array(
    z.object({
      book: z.string(),
      page: z.string(),
      reason: z.enum(["draft", "no_truth"]),
    }),
  ),
  failures: z.array(
    z.object({
      book: z.string(),
      page: z.string(),
      reason: z.enum(["image_missing", "read_failed"]),
      detail: z.string().optional(),
    }),
  ),
});
export type Run = z.infer<typeof Run>;

export interface ScoreOptions {
  root: string;
  books: readonly string[];
  reader: PageReader;
  now?: Date;
}

export async function scoreBooks({
  root,
  books,
  reader,
  now = new Date(),
}: ScoreOptions): Promise<Run> {
  const run: Run = {
    id: `${now.toISOString().replace(/[:.]/g, "-")}-${reader.name}`,
    created_at: now.toISOString(),
    reader: reader.name,
    totals: emptyScores(),
    pages: [],
    skipped: [],
    failures: [],
  };

  for (const book of books) {
    const manifest = await loadManifest(root, book);
    for (const page of manifest.pages) {
      const truth = await loadTruth(root, book, page.id);
      if (truth === null || truth.status === "draft") {
        run.skipped.push({
          book,
          page: page.id,
          reason: truth === null ? "no_truth" : "draft",
        });
        continue;
      }
      const image = join(bookPaths(root, book).images, page.image);
      if (!(await exists(image))) {
        run.failures.push({ book, page: page.id, reason: "image_missing" });
        continue;
      }

      let reading;
      try {
        reading = await reader.read({ path: image, pdf_page: page.pdf_page });
      } catch (error) {
        run.failures.push({
          book,
          page: page.id,
          reason: "read_failed",
          detail: String(error),
        });
        continue;
      }
      const scores = emptyScores();
      for (const name of METRIC_NAMES) {
        const metric: Metric = METRICS[name];
        scores[name] = metric.score(truth, reading.content, reading.usage);
        run.totals[name] = add(run.totals[name], scores[name]);
      }
      run.pages.push({
        book,
        page: page.id,
        scores,
        usage: reading.usage,
        prediction: reading.content,
      });
    }
  }
  return run;
}

/** Writes the run to `<root>/runs/<id>.json` and returns the path. */
export async function writeRun(root: string, run: Run): Promise<string> {
  const dir = join(root, "runs");
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${run.id}.json`);
  await writeFile(path, `${JSON.stringify(run, null, 2)}\n`);
  return path;
}

export interface ComparisonRow {
  metric: MetricName;
  a: number | null;
  b: number | null;
  /** b − a, or null when either run didn't measure the metric. */
  delta: number | null;
  /** Whether b improves on a, or null when there's no difference to judge. */
  better: boolean | null;
}

export function compareRuns(a: Run, b: Run): ComparisonRow[] {
  return METRIC_NAMES.map((metric) => {
    const x = value(a.totals[metric]);
    const y = value(b.totals[metric]);
    const delta = x === null || y === null ? null : y - x;
    const better =
      delta === null || delta === 0
        ? null
        : delta < 0 === METRICS[metric].lowerIsBetter;
    return { metric, a: x, b: y, delta, better };
  });
}

/** One run's totals as a table. */
export function formatRun(run: Run): string {
  const rows = METRIC_NAMES.map((name) => {
    const ratio = run.totals[name];
    return [
      METRICS[name].label,
      show(name, value(ratio)),
      `${trim(ratio.num)} / ${trim(ratio.den)}`,
    ];
  });
  const accounted = [
    `pages scored: ${String(run.pages.length)}`,
    `skipped: ${String(run.skipped.length)}`,
    `failed: ${String(run.failures.length)}`,
  ].join(" · ");
  return `${table([`run ${run.id}`, "value", "measured"], rows)}\n${accounted}`;
}

/** Two runs side by side, with the difference and whether it's an improvement. */
export function formatComparison(a: Run, b: Run): string {
  const rows = compareRuns(a, b).map((row) => [
    METRICS[row.metric].label,
    show(row.metric, row.a),
    show(row.metric, row.b),
    showDelta(row.metric, row.delta),
    row.better === null ? "" : row.better ? "better" : "worse",
  ]);
  return table(["metric", a.id, b.id, "change", ""], rows);
}

function emptyScores(): Record<MetricName, Ratio> {
  return Object.fromEntries(
    METRIC_NAMES.map((name) => [name, EMPTY]),
  ) as Record<MetricName, Ratio>;
}

function show(metric: MetricName, v: number | null): string {
  if (v === null) return "—";
  switch (METRICS[metric].unit) {
    case "percent":
      return `${(v * 100).toFixed(1)}%`;
    case "usd":
      return `$${v.toFixed(4)}`;
    case "iou":
      return v.toFixed(3);
  }
}

function showDelta(metric: MetricName, d: number | null): string {
  if (d === null) return "—";
  const sign = d < 0 ? "-" : "+";
  const size = Math.abs(d);
  switch (METRICS[metric].unit) {
    case "percent":
      return `${sign}${(size * 100).toFixed(1)} pts`;
    case "usd":
      return `${sign}$${size.toFixed(4)}`;
    case "iou":
      return `${sign}${size.toFixed(3)}`;
  }
}

function trim(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(4);
}

function table(header: string[], rows: string[][]): string {
  const all = [header, ...rows];
  const widths = header.map((_, i) =>
    Math.max(...all.map((row) => (row[i] ?? "").length)),
  );
  const line = (row: string[]) =>
    row
      .map((cell, i) => cell.padEnd(widths[i] ?? 0))
      .join("  ")
      .trimEnd();
  return [
    line(header),
    widths.map((w) => "-".repeat(w)).join("  "),
    ...rows.map(line),
  ].join("\n");
}
