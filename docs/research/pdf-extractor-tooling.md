# PDF extractor tooling

> **Stub: the full research, with its sources, still needs to be pasted in.**
> The original is `docs/research/pdf-extractor-tooling.md` in the `refactor/rooms-2-videos` worktree of the `almahdi` repo. It isn't committed to that branch on GitHub and wasn't on this machine, so E-01 couldn't copy it. Replace this whole file with the original.
>
> Until then, this page repeats only what spec #1 §5 already records. It adds nothing and cites nothing new.

## Choices (spec #1 §5)

| Part            | Choice                                                                                                                                                                                     |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Reading pages   | Vision model, one page image per call. An OCR/layout add-on (Azure Document Intelligence Layout v4 vs Mistral OCR 4) is adopted **only if** the golden-set trial (E-06) justifies its cost |
| Model access    | OpenRouter (zero data retention, `provider.require_parameters: true`) **or** Vertex AI, one setting per API key. The model name is config, never hard-coded at a call site                 |
| Model output    | Vercel AI SDK (`generateText` + `Output.object`) + Zod 4                                                                                                                                   |
| Page rendering  | poppler as a **separate process** (GPL is fine unlinked. Never use native poppler bindings)                                                                                                |
| Jobs            | pg-boss (per-key `groupConcurrency`, retries, dead-letter queue) + a status column on `documents`                                                                                          |
| Runtime         | Cloud Run: API service (+ static page) and a worker pool                                                                                                                                   |
| Page UI         | React + Vite, served as static files by the API service. Headless Tree for the editor. CSS logical properties for right-to-left layout                                                     |
| Accounts & keys | Better Auth (organisations, Google + email sign-in, API-key plugin)                                                                                                                        |
| Math            | LaTeX, validated with KaTeX (`throwOnError`), rendered/exported with Temml → MathML (`dir="rtl"` where needed)                                                                             |
| Exports         | JSON, xlsx, docx/pdf                                                                                                                                                                       |
| Contract        | OpenAPI generated from the Zod schemas, plus a generated typed client                                                                                                                      |
| Quality         | promptfoo + our own TS scorers over the golden set                                                                                                                                         |

## Excluded (spec #1 §5)

- mupdf.js / PyMuPDF (AGPL)
- Marker/Surya weights (free only under $5M in revenue or funding)
- MinerU (must be credited in the product, and the licence ends automatically on any breach)
- AWS Textract (no Arabic)
- Any PDF text layer for Arabic (Docling and pdf.js reverse or jumble it: read images)
- `@citolab/qti-components` (GPL-3.0)
- Self-hosted Inngest/Restate servers (SSPL/BSL)
- Lucia (deprecated)
- pdf-lib for anything but trivial assembly (unmaintained)
