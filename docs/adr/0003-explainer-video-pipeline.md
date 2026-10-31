# 0003 — Explainer-video pipeline (style A)

Status: accepted. Source: the Arabic explainer-video research report (October 2026), style A.

## Context

Engines turns a teacher's book into questions and explanation. Style A adds the next step: a **lesson script** (scenes of narrated slides) rendered to an MP4 in Egyptian Arabic. Script writing by a model, OCR of the book into a script, and style B (animated derivations) come later; this record covers the core: schema, templates, per-scene voice, timing, render and concat, plus the review states.

## Decision

`src/video/` is one module with the usual seams:

| File           | Does                                                                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `schema.ts`    | The Zod scene schema, the contract between a script and the renderer. Four scene types: `title`, `bullets`, `figure`, `equation_steps`.    |
| `tts.ts`       | `Voice` seam. `openRouterVoice` (model, voice and style are config) and `scriptedVoice` (silent takes, for tests and `--dry`).             |
| `timing.ts`    | `Aligner` seam. Default: sentence times from the measured audio length. A wav2vec2 word aligner can replace it without touching templates. |
| `templates.ts` | Scene → one HTML page, `dir="rtl"`, maths as MathML (Temml, `dir="rtl"` for equations), fonts bundled, no network at render time.          |
| `render.ts`    | HyperFrames CLI and FFmpeg as child processes (like poppler). Per-scene MP4, then stream-copy concat.                                      |
| `produce.ts`   | Lesson → MP4. Clips are cached by content hash; a failed scene goes to `failures` with a reason and the lesson goes on (hard rule 5).      |
| `checks.ts`    | The automatic checks (`auto_checked`): empty narration, maths markup in narration, invalid LaTeX, figure paths outside the lesson.         |
| `lessons.ts`   | The `lessons` table and the review states.                                                                                                 |

### Choices worth knowing

- **HyperFrames** (Apache-2.0) renders; Remotion's company licence was avoided. Its transitive licences were scanned: nothing GPL/AGPL/SSPL.
- **No GSAP.** HyperFrames drives a composition through `window.__timelines`; the templates register a small seek-driven timeline instead, so every frame is a pure function of time and nothing is fetched from a CDN. This also sidesteps GSAP's licence.
- **Chromium** is found like the PDF exports find it (`CHROMIUM_PATH`), and passed to HyperFrames as `HYPERFRAMES_BROWSER_PATH`. Telemetry and update checks are switched off for the child process.
- **Equations** are rendered, not cropped: Arabic letters (س، ص), Arabic-Indic digits and right-to-left flow, as the Egyptian books print them.
- **Review states**: `draft → auto_checked → in_review → approved → published`. `check` needs no error; `submit` needs a rendered video; `reject` and any script change return to `draft` (and drop the video); an approved or published lesson is frozen.
- **Delivery** is the simplest thing: `GET /v1/lessons/{id}` returns a time-limited MP4 URL. No webhook yet.

## Not yet done

- The voice adapter follows OpenRouter's streamed chat-completions audio shape and has only been tested against a mock. The voice model and voice name are unset by default (`TTS_MODEL`, `TTS_VOICE`); the default voice name in config comes from the research report and is unverified.
- Word-level timing (forced alignment) and karaoke captions.
- Script generation from a book, the critic pass and maths checks (mathjs).
- Rendering inside the worker: today `npm run video` renders and attaches the MP4.
- A review UI on the page.
