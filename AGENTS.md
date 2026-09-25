# AGENTS.md

**Engines** is a standalone product: a teacher's own book (a PDF or photos) goes in, questions and explanation come out, each filed under the teacher's own syllabus tree. **Almahdi** (the e-learning platform, repo `almahdi`) is customer zero and talks to Engines only over `/v1/`, like any other customer.

The spec every ticket is built from is [issue #1](https://github.com/almahdiplatform1712006/engines/issues/1). Tickets are its sub-issues and link to its sections (§1 … §10).

## Hard rules

These come from spec #1 and override anything else you read or infer.

1. **Content only.** Engines processes a teacher's own material. It never receives student messages, answers or scores.
2. **Never touch Almahdi's live platform.** Engines runs inside Almahdi's Google Cloud project but on its **own** Cloud SQL servers (production and a separate dev server), its own service account, buckets and capped AI key. Never connect to Almahdi's database, buckets or secrets, and never use Almahdi's production Cloud SQL server for dev.
3. **No secrets in the repo.** Keys come from Secret Manager or local `.env` files, which are git-ignored. `.env.example` lists every setting with no real values.
4. **Placement is never a guess.** _Where_ an item belongs (tree node) is decided by plain code from page ranges. The model reads pages. It never decides placement.
5. **Nothing is dropped silently.** Anything attempted and not delivered goes to `failures` with a reason. Anything skipped is counted.

Also from the spec: the model name is config, never hard-coded at a call site. poppler runs as a separate process, never through native bindings. Check §5's excluded list (AGPL/GPL/SSPL tools and others) before adding a dependency.

## Layout

| Path             | What                                                                        |
| ---------------- | --------------------------------------------------------------------------- |
| `src/api/`       | HTTP service (Hono). `app.ts` builds the app, `main.ts` serves it           |
| `src/worker/`    | pg-boss worker. `worker.ts` starts the pipeline, `main.ts` runs it          |
| `src/contract/`  | Zod schemas of every `/v1/` shape                                           |
| `src/pipeline/`  | The document stage machine: render, per-page reads, finish                  |
| `src/assembly/`  | Pure: page readings + tree + offset → result (placement lives here)         |
| `src/reading/`   | The model seam: `PageReader`, the model adapter, the scripted adapter       |
| `src/offset/`    | Pure: printed ↔ PDF page mapping                                            |
| `src/outline/`   | Syllabus tree validation and storage                                        |
| `src/render/`    | poppler (`pdftoppm` → `pdftocairo`) and photo normalisation                 |
| `src/storage/`   | `BlobStore`: local disk (dev, tests) and Google Cloud Storage               |
| `src/accounts/`  | Organisations, API keys, `authenticate`                                     |
| `src/shared/`    | Config (Zod-parsed env), database pool and migrations, text normalisation   |
| `src/golden/`    | Golden-set tools: file formats, drafting, correction sheet, scorers         |
| `golden/`        | Golden-set manifests, truth files and runs. Page images are never committed |
| `migrations/`    | SQL migrations (node-pg-migrate, `-- Up Migration` / `-- Down Migration`)   |
| `test/`          | Test harness: Postgres, the whole stack on a scripted reader, PDF builder   |
| `docs/adr/`      | Architecture decisions. Read `0001` before touching the pipeline            |
| `docs/research/` | Tooling research behind spec §5                                             |
| `docs/agents/`   | How agents use the issue tracker, labels and domain docs                    |

## Stack

Node 24, strict TypeScript, ESM, one package. Node runs the `.ts` sources directly (type stripping), so there's no build step and `tsc` only typechecks. That means **erasable syntax only**: no `enum`, `namespace` or parameter properties, and relative imports keep their `.ts` extension.

Hono (HTTP) · Zod 4 (schemas) · node-pg-migrate (migrations) · pg-boss (jobs, in Engines' own Postgres) · `node:test` (tests) · ESLint with typescript-eslint strict type-checked · Prettier.

## Running locally

Needs Node 24. Docker is needed for the compose database and the image, not for the tests.

```sh
npm install
cp .env.example .env          # local values only

npm run typecheck
npm run lint
npm run format:check
npm test                      # unit + database tests
```

`npm test` runs the database tests against `DATABASE_URL` when it's set (CI sets it to a Postgres service container). When it isn't set, it starts a throwaway embedded Postgres for the run, so no Docker is needed. Each test file gets its own fresh database.

The whole stack in Docker:

```sh
docker compose up --build     # postgres, then migrate, then api (:8080) and worker
curl localhost:8080/v1/health # {"status":"ok"}
```

Or run the pieces on the host against the compose database:

```sh
npm run db:up                 # local Postgres on :5432
npm run migrate
npm run start:api
npm run start:worker
```

Nothing here connects to any Google Cloud database.

Run a book through the engine locally (needs `AI_MODEL` and `OPENROUTER_API_KEY` in `.env`, and poppler on the host):

```sh
npm run seed -- "My organisation"      # prints an API key
KEY=eng_…
curl -s localhost:8080/v1/uploads -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"filename":"book.pdf","content_type":"application/pdf","size":'$(stat -c%s book.pdf)'}'
curl -s -X PUT --data-binary @book.pdf "<upload_url>"
curl -s localhost:8080/v1/outlines -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"source":{"type":"manual","nodes":[{"name":"Lesson 1","printed_pages":{"from":1,"to":10}}]}}'
curl -s -X POST localhost:8080/v1/outlines/<outline_id>/confirm -H "authorization: Bearer $KEY"
curl -s localhost:8080/v1/documents -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"outline_id":"<outline_id>","type":"questions","source":{"upload_id":"<upload_id>"}}'
curl -s localhost:8080/v1/documents/<document_id> -H "authorization: Bearer $KEY"
```

## Golden set

Extraction quality is measured against hand-corrected pages. See `golden/README.md` for the format and workflow.

```sh
npm run golden:draft -- <book>   # reader drafts truth/<page>.json and writes sheet.html
npm run golden:score             # score the current reader, write golden/runs/<run>.json
npm run golden:score -- --compare golden/runs/<a>.json golden/runs/<b>.json
```

Book page images are copyright: never commit them.

## CI

`.github/workflows/ci.yml` runs on every pull request: typecheck, lint, format check and `npm test` against a Postgres service. It then builds the image, checks `pdftoppm`/`pdftocairo` are in it, checks `GET /v1/health` returns 200 from the container, and runs the migrations twice on the compose Postgres.
