# Golden set

The golden set turns "is extraction good?" into numbers. It is a handful of real book pages, with the correct result for each written down by hand. Every change to the page reader, its prompt or its model is scored against it (spec #1 §5 Quality, decision Q30: the owner picks the pages, the model drafts the correct results, the owner corrects them).

The code lives in `src/golden/`. The files below are its input and output.

## Layout

```
golden/
  <book>/
    manifest.json         committed: which pages are in the set
    truth/<page>.json     committed: the correct result for each page
    images/<file>         NEVER committed: the page images
    sheet.html            not committed: the correction sheet
  runs/<run>.json         scoring runs, commit the ones you want to compare against
```

**Page images are never committed** (copyright). They live in Engines' private bucket or on local disk. Before drafting or scoring, copy a book's images into `golden/<book>/images/`, for example with `gcloud storage cp 'gs://<engines-golden-bucket>/<book>/*' golden/<book>/images/`. `golden/.gitignore` ignores every `images/` folder and every image or PDF file under `golden/`, and a test (`src/golden/no-images.test.ts`) fails if one is ever tracked.

Book and page ids are lowercase letters, digits and dashes (`physics-g10`, `p093`).

## `manifest.json`

```json
{
  "book": "physics-g10",
  "title": "الفيزياء — الصف الأول الثانوي",
  "pages": [
    { "id": "p011", "pdf_page": 11, "image": "p011.png" },
    { "id": "p093", "pdf_page": 93, "image": "p093.png" }
  ]
}
```

`book` must match the folder name. `image` is a file name inside `images/`. Pick pages that cover the hard cases: passages with several questions, diagrams, questions running onto the next page, answer-key pages, dense math, explanation pages, pages with no printed number.

## `truth/<page>.json`

The same item shapes as the `/v1/` result (spec §3), for one page:

```json
{
  "status": "corrected",
  "pdf_page": 93,
  "printed_page": 89,
  "stimuli": [
    {
      "id": "s1",
      "kind": "passage",
      "text": "سقط جسم كتلته 5 kg من ارتفاع 20 m عن سطح الأرض. أجب عما يلي:",
      "crop": { "x": 0.08, "y": 0.12, "w": 0.84, "h": 0.07 }
    }
  ],
  "questions": [
    {
      "id": "q1",
      "number": "3",
      "type": "multiple_choice",
      "text": "طاقة الوضع للجسم لحظة سقوطه تساوي:",
      "options": [
        { "key": "أ", "text": "$1000\\ \\text{J}$" },
        { "key": "ب", "text": "$100\\ \\text{J}$" }
      ],
      "correct": ["أ"],
      "accepted_answers": [],
      "answer_source": "book",
      "stimulus_id": "s1",
      "math_direction": "ltr",
      "crop": { "x": 0.08, "y": 0.2, "w": 0.84, "h": 0.1 }
    }
  ],
  "explanation": [
    {
      "heading": "طاقة الوضع",
      "markdown": "طاقة الوضع $PE = mgh$ ...",
      "crop": null
    }
  ]
}
```

| Field                          | Meaning                                                                                                         |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `status`                       | `draft` (the reader's guess, never scored) or `corrected` (checked by the owner)                                |
| `pdf_page`                     | The page's position in the PDF, from the manifest                                                               |
| `printed_page`                 | The page number printed on the page, or `null` if none is printed                                               |
| `stimuli[]`                    | Passages, diagrams and tables that questions share. `kind` is `passage`, `diagram` or `table`                   |
| `questions[].type`             | `multiple_choice`, `fill_blank` or `true_false`                                                                 |
| `questions[].number`           | The question number as printed, or `null`                                                                       |
| `questions[].correct`          | Correct option keys (`multiple_choice`, `true_false`)                                                           |
| `questions[].accepted_answers` | Accepted answers (`fill_blank`)                                                                                 |
| `questions[].answer_source`    | `book` (answer key), `marked` (ticked on the page), `model`, or `null` if there is no answer                    |
| `questions[].stimulus_id`      | The `id` of the stimulus the question belongs to, or `null`                                                     |
| `questions[].math_direction`   | `ltr` or `rtl`, as printed, or `null` if there is no math                                                       |
| `explanation[]`                | Heading-bounded explanation blocks, as Markdown with LaTeX                                                      |
| `crop`                         | A box on the page image, as fractions (0–1) of the image's width and height from its top-left corner, or `null` |

Math is LaTeX, copied exactly as printed, inside `$…$`, `$$…$$`, `\(…\)` or `\[…\]`. Ids (`s1`, `q1`) only need to be unique within the page: scoring matches items by their text, never by id.

## Workflow

1. Add `golden/<book>/manifest.json` and put the page images in `golden/<book>/images/`.
2. Draft: `npm run golden:draft -- <book>`. The current page reader (`GOLDEN_READER`, default `stub`) reads each page and writes `truth/<page>.json` with `status: "draft"`. Existing truth is kept (`--force` replaces drafts, but never corrected truth). A page whose image is missing is reported, not skipped. It also writes `sheet.html`.
3. Correct: open `golden/<book>/sheet.html` in a browser. Each page image sits next to its draft. Fix the JSON and press "Save as corrected". Chrome and Edge write straight into the book's `truth/` folder, and other browsers download the file for you to move there. `npm run golden:sheet -- <book>` rebuilds the sheet.
4. Score: `npm run golden:score` (all books) or `npm run golden:score -- <book> …`. This reads every corrected page with the current reader, prints a table, and writes `golden/runs/<run>.json`. Pages still in draft or without truth are listed as skipped. Add `--baseline golden/runs/<older>.json` to see the difference from an earlier run.
5. Compare two existing runs: `npm run golden:score -- --compare golden/runs/<a>.json golden/runs/<b>.json`.

Only the stub reader exists until the reading tickets (E-05, E-06) add the model reader to `src/golden/reader.ts`. The stub reads nothing and costs nothing, so drafts start empty.

## Scores

Each score is kept as a numerator and denominator, so pages add up into run totals without averaging averages. A score with nothing to measure shows `—`.

| Score                   | What it measures                                                                                    |
| ----------------------- | --------------------------------------------------------------------------------------------------- |
| question recall         | Truth questions the reader found                                                                    |
| question precision      | Predicted questions that are real questions on the page                                             |
| option-set exact match  | Found questions whose options (key and text, any order) are exactly right                           |
| correct-answer accuracy | Found questions whose correct keys (or accepted answers for `fill_blank`) are right                 |
| stimulus-link accuracy  | Found questions linked to the right passage or diagram, or rightly to none                          |
| crop IoU                | Mean overlap (intersection over union) of question and stimulus crop boxes. A missing crop scores 0 |
| explanation CER         | Character error rate of the explanation text (lower is better)                                      |
| LaTeX KaTeX-parse rate  | Math spans in the reader's output that KaTeX parses                                                 |
| printed-page accuracy   | Pages whose printed number was read right                                                           |
| cost per page (USD)     | Logged model cost per page (lower is better)                                                        |

Questions and stimuli are matched to the truth by text similarity after normalisation (at least 70% alike, best pairs first). Text is normalised before every comparison: tatweel is stripped, `أ إ آ ٱ` become `ا`, `ى ی` become `ي`, Arabic-Indic digits become ASCII, and whitespace is collapsed.

The scorers are plain TypeScript (`src/golden/scorers.ts`), so a promptfoo config can call them later if we want its UI.
