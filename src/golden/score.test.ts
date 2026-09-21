import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { PageReader } from "./reader.ts";
import {
  type ComparisonRow,
  compareRuns,
  formatComparison,
  type MetricName,
  type Run,
  scoreBooks,
} from "./score.ts";
import type { PageTruth, Question } from "./truth.ts";

const force: Question = {
  id: "q1",
  number: "1",
  type: "multiple_choice",
  text: "ما وحدة قياس القوة؟",
  options: [
    { key: "أ", text: "نيوتن" },
    { key: "ب", text: "جول" },
  ],
  correct: ["أ"],
  accepted_answers: [],
  answer_source: "book",
  stimulus_id: null,
  math_direction: null,
  crop: null,
};
const work: Question = {
  ...force,
  id: "q2",
  number: "2",
  text: "ما وحدة قياس الشغل؟",
  correct: ["ب"],
};

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "engines-golden-"));
  const book = join(root, "physics-g10");
  await mkdir(join(book, "images"), { recursive: true });
  await mkdir(join(book, "truth"), { recursive: true });
  await writeFile(
    join(book, "manifest.json"),
    JSON.stringify({
      book: "physics-g10",
      title: "الفيزياء",
      pages: [
        { id: "p011", pdf_page: 11, image: "p011.png" },
        { id: "p012", pdf_page: 12, image: "p012.png" },
        { id: "p013", pdf_page: 13, image: "p013.png" },
        { id: "p014", pdf_page: 14, image: "p014.png" },
      ],
    }),
  );
  const truth = (pdf_page: number, status: PageTruth["status"]): PageTruth => ({
    status,
    pdf_page,
    printed_page: pdf_page - 4,
    stimuli: [],
    questions: [force, work],
    explanation: [],
  });
  await writeFile(
    join(book, "truth", "p011.json"),
    JSON.stringify(truth(11, "corrected")),
  );
  await writeFile(
    join(book, "truth", "p012.json"),
    JSON.stringify(truth(12, "draft")),
  );
  await writeFile(
    join(book, "truth", "p013.json"),
    JSON.stringify(truth(13, "corrected")),
  );
  // p014 has no truth yet. p013's image is missing.
  for (const image of ["p011.png", "p012.png", "p014.png"]) {
    await writeFile(join(book, "images", image), "not a real page");
  }
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Finds the first question, reads the printed number right, and logs a cost. */
const partReader: PageReader = {
  name: "part",
  read: (image) =>
    Promise.resolve({
      content: {
        pdf_page: image.pdf_page,
        printed_page: image.pdf_page - 4,
        stimuli: [],
        questions: [{ ...force, id: "x1" }],
        explanation: [],
      },
      usage: { input_tokens: 1500, output_tokens: 400, cost_usd: 0.003 },
    }),
};

describe("scoreBooks", () => {
  test("scores only corrected pages, and accounts for every page it didn't score", async () => {
    const run = await scoreBooks({
      root,
      books: ["physics-g10"],
      reader: partReader,
      now: new Date(0),
    });

    assert.equal(run.reader, "part");
    assert.deepEqual(
      run.pages.map((p) => p.page),
      ["p011"],
    );
    assert.deepEqual(run.totals.question_recall, { num: 1, den: 2 });
    assert.deepEqual(run.totals.question_precision, { num: 1, den: 1 });
    assert.deepEqual(run.totals.printed_page, { num: 1, den: 1 });
    assert.deepEqual(run.totals.cost_per_page_usd, { num: 0.003, den: 1 });
    assert.deepEqual(run.skipped, [
      { book: "physics-g10", page: "p012", reason: "draft" },
      { book: "physics-g10", page: "p014", reason: "no_truth" },
    ]);
    assert.deepEqual(run.failures, [
      { book: "physics-g10", page: "p013", reason: "image_missing" },
    ]);
  });

  test("a broken truth file fails that page and the run carries on", async () => {
    await writeFile(
      join(root, "physics-g10", "truth", "p012.json"),
      JSON.stringify({ status: "corrected", pdf_page: 12 }),
    );

    const run = await scoreBooks({
      root,
      books: ["physics-g10"],
      reader: partReader,
    });

    assert.deepEqual(
      run.pages.map((p) => p.page),
      ["p011"],
    );
    const failure = run.failures.find((f) => f.page === "p012");
    assert.ok(failure);
    assert.equal(failure.reason, "invalid_truth");
    assert.match(failure.detail ?? "", /p012\.json/);
  });

  test("a reader that throws fails that page and the run carries on", async () => {
    const flaky: PageReader = {
      name: "flaky",
      read: (image) =>
        image.pdf_page === 11
          ? Promise.reject(new Error("model timed out"))
          : partReader.read(image),
    };

    const run = await scoreBooks({
      root,
      books: ["physics-g10"],
      reader: flaky,
    });

    assert.deepEqual(run.failures, [
      {
        book: "physics-g10",
        page: "p011",
        reason: "read_failed",
        detail: "Error: model timed out",
      },
      { book: "physics-g10", page: "p013", reason: "image_missing" },
    ]);
  });
});

function run(
  id: string,
  recall: [number, number],
  cost: [number, number],
): Run {
  const ratio = ([num, den]: [number, number]) => ({ num, den });
  const empty = { num: 0, den: 0 };
  return {
    id,
    created_at: "2026-09-21T00:00:00.000Z",
    reader: "stub",
    totals: {
      question_recall: ratio(recall),
      question_precision: empty,
      option_set_exact: empty,
      correct_answer: empty,
      stimulus_link: empty,
      crop_iou: empty,
      explanation_cer: empty,
      latex_parse_rate: empty,
      printed_page: empty,
      cost_per_page_usd: ratio(cost),
    },
    pages: [],
    skipped: [],
    failures: [],
  };
}

function row(rows: ComparisonRow[], metric: MetricName): ComparisonRow {
  const found = rows.find((r) => r.metric === metric);
  assert.ok(found, `no row for ${metric}`);
  return found;
}

describe("compareRuns", () => {
  test("gives each metric's value in both runs and the difference", () => {
    const rows = compareRuns(
      run("before", [6, 10], [0.02, 4]),
      run("after", [9, 10], [0.012, 4]),
    );

    const recall = row(rows, "question_recall");
    assert.equal(recall.a, 0.6);
    assert.equal(recall.b, 0.9);
    assert.ok(Math.abs((recall.delta ?? 0) - 0.3) < 1e-9);
    assert.equal(recall.better, true);

    const cost = row(rows, "cost_per_page_usd");
    assert.equal(cost.a, 0.005);
    assert.equal(cost.b, 0.003);
    // Cheaper is better.
    assert.equal(cost.better, true);
  });

  test("has no difference for a metric one run didn't measure", () => {
    const rows = compareRuns(
      run("before", [0, 0], [0, 1]),
      run("after", [5, 10], [0, 1]),
    );

    const recall = row(rows, "question_recall");
    assert.equal(recall.a, null);
    assert.equal(recall.delta, null);
    assert.equal(recall.better, null);
  });

  test("prints a table naming both runs, with one row per metric", () => {
    const text = formatComparison(
      run("before", [6, 10], [0.02, 4]),
      run("after", [9, 10], [0.012, 4]),
    );

    assert.match(text, /before/);
    assert.match(text, /after/);
    assert.match(text, /question recall\s+60\.0%\s+90\.0%\s+\+30\.0 pts/);
    assert.match(
      text,
      /cost per page \(USD\)\s+\$0\.0050\s+\$0\.0030\s+-\$0\.0020/,
    );
  });
});
