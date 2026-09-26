# Webhooks

When a document's job ends (`completed`, `completed_with_errors` or `failed`), and each time a review saves a new revision, Engines POSTs to the document's `webhook_url`:

```json
{
  "id": "doc_8Pq3…",
  "object": "document",
  "status": "completed",
  "revision": 1
}
```

Fetch the full result with `GET /v1/documents/{id}`. The payload is only a notice.

## Delivery

- `webhook_url` must be `https://` and must resolve to a public address. Private, loopback, link-local and metadata addresses are refused, and redirects are not followed.
- Any response other than 2xx within 10 seconds is a failed delivery. It is retried with exponential backoff (starting at 30 seconds, capped at an hour) up to 8 times.
- Deliveries can repeat and can arrive out of order. Use `revision` to keep the latest.

## Verifying a delivery

Each delivery carries an `Engines-Signature` header:

```
Engines-Signature: t=1790000000,v1=5257a869e7ecebeda32affa62cdca3fa51cad7e77a0e56ff536d0ce8e108d8bd
```

`v1` is the hex HMAC-SHA256 of `<t>.<raw request body>`, keyed with your organisation's webhook secret. `GET /v1/webhook_secret` returns the secret. Verify against the **raw** body, before parsing it, and refuse old timestamps so a captured delivery can't be replayed:

```ts
import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyEnginesWebhook(
  secret: string,
  header: string | undefined,
  rawBody: string,
): boolean {
  const parts = Object.fromEntries(
    (header ?? "").split(",").map((p) => p.trim().split("=", 2)),
  );
  const t = Number(parts.t);
  if (!Number.isInteger(t) || !parts.v1) return false;
  if (Math.abs(Date.now() / 1000 - t) > 300) return false; // older than 5 minutes
  const expected = createHmac("sha256", secret)
    .update(`${t}.${rawBody}`)
    .digest("hex");
  return (
    expected.length === parts.v1.length &&
    timingSafeEqual(Buffer.from(expected), Buffer.from(parts.v1))
  );
}
```

The typed client (`@engines/client`) exports the same check as `verifyWebhook`.
