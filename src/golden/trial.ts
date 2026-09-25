// The reading trial (E-06): the golden set through each set-up (a model
// alone, or with a layout add-on), every run scored the same way, and the
// numbers as the table the decision record starts from. The owner decides.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { selectReader } from "./reader.ts";
import {
  METRIC_NAMES,
  METRICS,
  scoreBooks,
  show,
  writeRun,
  type MetricName,
  type Run,
} from "./score.ts";
import { value } from "./ratio.ts";

/** `golden/trial.json`: the set-ups to run. */
export const TrialConfig = z.object({
  setups: z
    .array(
      z.object({
        name: z.string().min(1),
        /** model | model+azure | model+mistral */
        reader: z.enum(["model", "model+azure", "model+mistral"]),
        /** The vision model's id (AI_MODEL for this set-up). */
        model: z.string().min(1),
      }),
    )
    .min(1),
});
export type TrialConfig = z.infer<typeof TrialConfig>;

export interface TrialRun {
  setup: TrialConfig["setups"][number];
  run: Run;
}

export async function runTrial(options: {
  root: string;
  books: readonly string[];
  config: TrialConfig;
  env: Record<string, string | undefined>;
}): Promise<TrialRun[]> {
  const runs: TrialRun[] = [];
  for (const setup of options.config.setups) {
    const reader = selectReader({
      ...options.env,
      GOLDEN_READER: setup.reader,
      AI_MODEL: setup.model,
    });
    const run = await scoreBooks({
      root: options.root,
      books: options.books,
      reader,
    });
    await writeRun(options.root, run);
    runs.push({ setup, run });
  }
  return runs;
}

/** What an add-on would be bought for, shown on their own first. */
const BOUGHT_FOR: MetricName[] = [
  "printed_page",
  "crop_iou",
  "cost_per_page_usd",
];

/** The decision record's draft: the numbers, and where the owner decides. */
export function trialReport(runs: readonly TrialRun[], date: string): string {
  const header = `| metric | ${runs.map((r) => r.setup.name).join(" | ")} |`;
  const rule = `|---|${runs.map(() => "---").join("|")}|`;
  const row = (metric: MetricName) =>
    `| ${METRICS[metric].label} | ${runs
      .map((r) => show(metric, value(r.run.totals[metric])))
      .join(" | ")} |`;
  const pages = runs
    .map(
      (r) =>
        `- **${r.setup.name}**: \`${r.setup.reader}\`, model \`${r.setup.model}\`, run \`${r.run.id}\`: ${String(r.run.pages.length)} pages scored, ${String(r.run.skipped.length)} skipped, ${String(r.run.failures.length)} failed.`,
    )
    .join("\n");
  return `# 0001 — Page reading: the model alone, or with a layout add-on

Status: **proposed, waiting for the owner's decision** (E-06, decision Q21). Trial run on ${date}.

## Set-ups

${pages}

## What an add-on would be bought for

${[header, rule, ...BOUGHT_FOR.map(row)].join("\n")}

## Every scorer

${[header, rule, ...METRIC_NAMES.map(row)].join("\n")}

Cost per page is from each run's logged usage: the model's calls as the provider reported them, plus the add-on's price per page as set in \`.env\` (not billed usage: check it against the add-on's invoice).

An add-on's crop IoU is measured on the boxes of text it matched to the model's blocks; figures it found without text aren't matched yet, so its crops may score below what it could do.

## Recommendation

_To write from the numbers above: adopt an add-on only if it clearly beats the model alone on printed-page accuracy or crop IoU for its cost per page._

## Contract changes

_Any field of spec #1 §3 the trial showed to be wrong or missing, proposed as an edit to the spec, never applied silently._
`;
}

export async function writeReport(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}
