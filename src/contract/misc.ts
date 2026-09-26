// The smaller `/v1/` shapes (spec #1 §3), as Zod, so the OpenAPI file and the
// typed client describe them too.
import { z } from "zod";
import { DocumentStatus, Warning } from "./document.ts";

/** `202` from `POST /v1/documents`. */
export const CreatedDocument = z.object({
  id: z.string(),
  object: z.literal("document"),
  status: DocumentStatus,
  /** Set when this exact file was processed before: a re-run is a new job. */
  warning: Warning.nullable(),
});

/** What Engines POSTs to a document's `webhook_url` (docs/webhooks.md). */
export const WebhookPayload = z.object({
  id: z.string(),
  object: z.literal("document"),
  status: DocumentStatus,
  /** Keep the latest: deliveries can repeat and arrive out of order. */
  revision: z.int(),
});
export type WebhookPayload = z.infer<typeof WebhookPayload>;

export const LedgerEntry = z.object({
  kind: z.enum(["grant", "hold", "release", "usage"]),
  pages: z.int(),
  document_id: z.string().nullable(),
  note: z.string().nullable(),
  created_at: z.string(),
});

export const Usage = z.object({
  object: z.literal("usage"),
  /** Page credits left. One credit is one page. */
  balance: z.int(),
  ledger: z.array(LedgerEntry),
});

export const WebhookSecret = z.object({
  object: z.literal("webhook_secret"),
  secret: z.string(),
});

/**
 * `POST /v1/sessions` (E-21): a one-time link that signs a visitor into
 * Engines' page for one outline or one document of this organisation.
 */
export const CreateSessionRequest = z
  .object({
    outline_id: z.string().optional(),
    document_id: z.string().optional(),
    /**
     * Where the page's "back" button goes. When the visit ran a document,
     * `?engines_document=<id>` is added.
     */
    return_url: z.url({ protocol: /^https?$/ }),
    /** Documents the visit runs are sent here when they end (docs/webhooks.md). */
    webhook_url: z.url({ protocol: /^https?$/ }).optional(),
  })
  .refine(
    (s) => (s.outline_id === undefined) !== (s.document_id === undefined),
    "Send an outline_id or a document_id, not both.",
  );
export type CreateSessionRequest = z.infer<typeof CreateSessionRequest>;

export const Session = z.object({
  object: z.literal("session"),
  /** Open it once, top-level (not in an iframe), before `expires_at`. */
  url: z.string(),
  expires_at: z.string(),
});
