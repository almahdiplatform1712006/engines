# 0001 — PDF engine architecture

Status: accepted (E-05 … E-14). Builds on spec #1 §3–§6.

## Context

The PDF engine turns an uploaded book into placed questions and explanation. Spec #1 fixes the flow, the `/v1/` contract and the stack. This record fixes how the code is cut into modules, so each ticket thickens one module instead of spreading through all of them.

## Decision

### Modules

Each module is deep: a small interface over the hard part, tested through that interface.

| Module           | Interface (what callers use)                                                                                                                                                                  | Hides                                                                                                                      |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `src/contract/`  | Zod schemas of every `/v1/` shape (outline node, document result, errors, webhook)                                                                                                            | Nothing. It is the single source for the API, the OpenAPI file and the typed client                                        |
| `src/outline/`   | `validateOutline(tree) → { errors, warnings }` (pure, shared with the page's editor) and an outline store                                                                                     | Range rules, sibling overlap, answer-key uniqueness                                                                        |
| `src/offset/`    | `samplePages(count)`, `fitSegments(pairs)`, `checkPages(segments, pages)`, `pdfToPrinted` / `printedToPdf` (pure)                                                                             | Digit normalisation, piecewise fit by runs, OCR outliers                                                                   |
| `src/reading/`   | `PageReader` (`readPage`, then `readPrintedNumber`, `readPair`, `solve`, `readContents` as tickets need them). Two adapters: `createModelReader` (Vercel AI SDK) and `scriptedReader` (tests) | Prompts, schemas, provider setup, `length` retries, usage and cost logging                                                 |
| `src/render/`    | `pageCount(file)`, `renderPage(file, page) → png`, `normalisePhoto(bytes)`, crops                                                                                                             | poppler as a child process (`pdftoppm`, falling back to `pdftocairo`), sharp                                               |
| `src/storage/`   | `BlobStore`: `put`, `get`, `size`, `delete`, `deletePrefix`, `signedUrl`, `createUpload`. Adapters: local filesystem and Google Cloud Storage                                                 | Resumable upload protocol, URL signing                                                                                     |
| `src/assembly/`  | `assemble(input) → { result, unanswered }` (pure)                                                                                                                                             | Continuations (E-09), placement (E-05/E-08), stimuli (E-10), answers (E-11), explanation chunks (E-12), checks (§4 step 9) |
| `src/documents/` | `createDocument` (every check before a document is queued) and the §3 view of a document                                                                                                      | SQL for creating and reading documents                                                                                     |
| `src/pipeline/`  | `registerPipeline(deps)`, `admit(tx, key)`: the stage machine, which owns every status transition                                                                                             | Queue names, per-page tasks, retries, settling, sweeps, webhooks                                                           |
| `src/accounts/`  | `authenticate(request) → org`, keys, credits, entitlements                                                                                                                                    | Hashing, ledger arithmetic                                                                                                 |
| `src/api/`       | `createApp(deps)`                                                                                                                                                                             | Hono routes, error mapping                                                                                                 |

Everything that decides **placement** lives in `src/assembly/` and `src/offset/`, is pure, and never calls a model (hard rule 4). The model is reached only through `PageReader`.

### The pipeline (`src/pipeline/`)

One module holds the stage machine. Each stage is a pg-boss queue with retries, backoff and a dead-letter queue.

```
POST /v1/documents ──► queued
admit (per-key cap) ─► rendering   render job: page count, one PNG per page (resumable: skips pages
                                   already stored), then the quick pass (E-07)
                     ─► awaiting_offset (releases its concurrency slot) … POST …/offset re-admits it
                     ─► processing  one page.read task per page
all pages settled   ─► pairs → solve stages (E-09, E-11), each fanning out and back in the same way
                     ─► finish: assemble (pure), crops, revision 1, usage, status, webhook — no model calls
                     ─► completed | completed_with_errors | failed
```

- **Settling.** A task records its outcome with a guarded update (`… WHERE state = 'pending'`) and, in the same transaction, decrements `documents.pages_pending`. The transaction that reaches zero enqueues the next stage through pg-boss's `db` option, so the send commits with it. A redelivered task finds its row settled and does nothing. The next-stage queue uses the `exclusive` policy keyed by document id.
- **Dead letters.** A task that throws on its last attempt, crashes or expires lands in its queue's dead-letter queue. That handler settles it as failed (a page becomes `part_failed`), so a document never waits on a lost task.
- **Idempotent finish.** Revision 1 is inserted with `ON CONFLICT DO NOTHING` and the status moves only from `processing`. Blobs (the book file) are deleted after commit; the expiry sweep is the backstop.
- **Model results are stored** (page readings in `pages.reading`, pair and solve results beside them), so a retried stage never pays twice.
- **Concurrency per key** is admission control in Postgres under a per-key advisory lock: a document holds a slot in `rendering` and `processing`, not while it waits for a person at `awaiting_offset`. `admit` runs when a document is created, when one ends or reaches `awaiting_offset`, and in the sweep. Page tasks carry `group: api key` so one large book doesn't starve other keys.

### Results as revisions

The finished result is stored whole, as JSON, in `revisions` (`document_id`, `number`, `result`, `changes`). Revision 1 is the pipeline's output. A review save writes the next number and never overwrites. `GET /v1/documents/{id}` reads the latest. This replaces the per-item tables (`questions`, `stimuli`, `explanation_chunks`, `failures`) listed in spec §6: nothing queries items across documents, and whole snapshots make "never overwrite the original" free. It is proposed as an amendment to spec §6 on issue #1 rather than applied silently. The back office reads failure counts from the JSON. Review saves carry the `base_revision` they edited and are refused on a mismatch.

### Model output shapes

The page reader asks for a flat block list (every block has every field, most nullable), because providers' JSON-schema modes handle flat objects better than unions. `toBlocks` normalises it straight away; a bad combination (a question without a type) is repaired and flagged, never thrown. Blocks come back in reading order, and that order, not the vertical position, is what splits a shared page at a heading (two-column and right-to-left pages). Crop boxes come back as Gemini-style `box_2d: [ymin, xmin, ymax, xmax]` on 0–1000 and are converted to 0–1 fractions (`CropBox`) in code. Printed page numbers come back as text and are normalised to integers in code (Arabic-Indic digits); Roman numerals and spreads read as "no number".

Every block has a stable id, `p<pdf page>#<order>`, and item ids derive from it (`q_93_2`), so ids stay the same across revisions.

The pair re-read (E-09) passes the two flagged halves as anchors by id and gets back only `{ joined: [{ replaces: [ids], block }] }`. Single-page readings stay authoritative for everything else.

### Offset segments

Segment _i_ maps printed pages from its `printed_from` up to just before the next segment starts, counted in printed pages and in PDF pages both (a scan missing a page shifts the mapping back, and two segments must never claim one PDF page). PDF pages no segment covers (front matter, an unnumbered plate) have no printed number. Segments whose printed numbers don't rise with their PDF pages (a restart at 1) are refused at confirmation, since they would map one printed page twice.

The fit takes runs of consecutive samples with the same shift; a run of one is a misread and is ignored. After the full read, a page whose printed number contradicts the confirmed segments is held as `offset_break`. So is an unnumbered page next to such a page. An unnumbered page between agreeing pages, a page with nothing but `neither` blocks, and a book with no page numbers at all are not breaks.

### Testing seams

- Pure modules (`outline`, `offset`, `assembly`) are table-tested directly.
- `PageReader` is the seam for the pipeline: integration tests run the whole path with `scriptedReader`, real poppler, real Postgres and the local blob store, so CI needs no model key.
- `createModelReader` is tested against the AI SDK's mock language model (schema rejection, `length` retry, usage logging), and one integration test runs the whole pipeline through it.
- Time comes from an injected `Clock`, so expiry is tested with a fake clock.

## Consequences

- Adding the video engine later means adding a job type and a reader, not touching placement.
- Result queries across documents (none today) would need a JSON query or a projection table.
- Admission control is our code, so its tests must cover races (two documents created at once for a cap-1 key).
