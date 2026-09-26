# Integrating with Engines

How another platform (Almahdi first) uses Engines: send its person to Engines' page, hear when a book is done, fetch the result, and file it under its own lessons. The API is described in [`openapi.json`](../openapi.json) (also served at `GET /v1/openapi.json`); the typed client, `@engines/client`, is built from it.

## 1. Set up

- Make an API key on Engines' page (**API keys**). It is shown once. Keep it on your server only.
- `GET /v1/webhook_secret` gives your organisation's webhook secret.
- Install the client: CI builds it as a tarball (`engines-client` artifact, or `npm run client:pack`); `npm install ./engines-client-1.0.0.tgz`.

```ts
import { createClient } from "@engines/client";

const engines = createClient({
  baseUrl: "https://engines.example",
  apiKey: process.env.ENGINES_API_KEY!,
});
```

## 2. Send the course's tree, then the person

Send your course as a starting tree. Each node carries your own id as `external_ref`; ranges can be left for the person to fill in.

```ts
const outline = await engines.outlines.create(
  {
    source: {
      type: "manual",
      nodes: course.units.map((unit) => ({
        name: unit.title,
        external_ref: `unit:${unit.id}`,
        children: unit.lessons.map((lesson) => ({
          name: lesson.title,
          external_ref: `lesson:${lesson.id}`,
        })),
      })),
    },
  },
  { idempotencyKey: `course-${course.id}-outline` },
);

const session = await engines.sessions.create({
  outline_id: outline.id,
  return_url: `https://almahdi.example/admin/courses/${course.id}`,
  // Every document the person runs reports here.
  webhook_url: "https://almahdi.example/engines/webhook",
});
// Redirect the person's browser to session.url (top-level, not in an iframe).
```

The link works once, for ten minutes. Someone already signed in to Engines is asked before the link makes them a visitor. It opens Engines' page on that outline only: the person fills in page ranges, confirms the tree, uploads the book, confirms the page offset and watches it run, then follows **Back to** your `return_url`. The visit can't see keys, other outlines or anything else of your organisation, and it runs the book through the key that made the link (its caps and credits).

To send someone to review a finished document instead, make the link with `document_id`.

## 3. Hear when it's done

Documents a visit runs report to the session's `webhook_url`; documents you create through the API report to their own `webhook_url`. When the person comes back through **Back to**, your `return_url` also carries `?engines_document=<id>` if they ran a document. Engines POSTs `{ id, object: "document", status, revision }` when the job ends and again for each review revision. Verify every delivery on the **raw** body before parsing it:

```ts
import { verifyWebhook, SIGNATURE_HEADER } from "@engines/client";

app.post("/engines/webhook", async (req, res) => {
  const body = await rawBody(req);
  const ok = await verifyWebhook({
    secret: process.env.ENGINES_WEBHOOK_SECRET!,
    header: req.headers[SIGNATURE_HEADER],
    body,
  });
  if (!ok) return res.status(400).end();
  const { id, revision } = JSON.parse(body);
  await queue.add("engines-document", { id, revision });
  res.status(200).end();
});
```

Deliveries can repeat and arrive out of order: keep the highest `revision` you have seen per document. See [webhooks.md](webhooks.md) for the retry schedule.

## 4. Fetch and map by `external_ref`

```ts
const doc = await engines.documents.get(id);
for (const question of doc.questions) {
  const lesson = question.external_ref; // "lesson:42", or null for a node the person added
  // …
}
```

- Every question and explanation chunk carries the `node_id`, `node_path` and `external_ref` of the node it was filed under. A node the person renamed keeps its `external_ref`; a node they added has none: map those by `node_path` (a mapping screen that suggests matches with `normalizeArabic()` works well).
- `review_required` / `review_reason` flag items a person should look at (a model answer, an uncertain passage link, a figure that couldn't be cut). `failures` lists what couldn't be delivered, with reasons.
- A later revision replaces the result as a whole: update only the rows still pending review on your side.
- Results, page images and exports are kept 30 days; after that `GET` is `410`.

## Errors

Every refusal is `{ error: { code, message, details? } }`; the client throws `EnginesError` with `status`, `code` and `details`. The ones to handle: `402 insufficient_credits`, `403 not_entitled`, `409 outline_not_confirmed`, `413 too_large`, `429 too_many_jobs` (wait `Retry-After`), `410 gone`. Creates take an `Idempotency-Key`, so a retry never makes a second job.
