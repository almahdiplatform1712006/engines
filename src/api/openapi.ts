// `openapi.json` (E-21): the `/v1/` API described from the same Zod schemas
// the routes check requests against, so the file can't say something the API
// doesn't do. `npm run openapi` writes it; CI fails when it drifts.
import { z } from "zod";
import { CropBox } from "../contract/crop.ts";
import {
  ConfirmOffsetRequest,
  CreateDocumentRequest,
  Document,
} from "../contract/document.ts";
import {
  CreatedDocument,
  CreateSessionRequest,
  Session,
  Usage,
  WebhookPayload,
  WebhookSecret,
} from "../contract/misc.ts";
import {
  CreateOutlineRequest,
  Outline,
  OutlineNode,
  OutlineNodeInput,
  ReplaceOutlineRequest,
} from "../contract/outline.ts";
import { Change, CreateRevisionRequest } from "../contract/revision.ts";
import { CreateUploadRequest, UploadView } from "../uploads/uploads.ts";
import { ErrorBody } from "./errors.ts";

/** The `/v1/` API's version, as openapi.json and the typed client give it. */
export const API_VERSION = "1.0.0";

// Named schemas become `components.schemas`, referred to by name.
const SCHEMAS = {
  Outline,
  OutlineNode,
  OutlineNodeInput,
  CreateOutlineRequest,
  ReplaceOutlineRequest,
  Document,
  CreateDocumentRequest,
  CreatedDocument,
  ConfirmOffsetRequest,
  CreateRevisionRequest,
  Change,
  CropBox,
  CreateUploadRequest,
  Upload: UploadView,
  Usage,
  WebhookSecret,
  WebhookPayload,
  CreateSessionRequest,
  Session,
  Error: ErrorBody,
} satisfies Record<string, z.ZodType>;
type SchemaName = keyof typeof SCHEMAS;

const ERRORS: Record<number, string> = {
  400: "invalid_request",
  401: "unauthorized",
  402: "insufficient_credits",
  403: "not_entitled / forbidden",
  404: "not_found",
  409: "outline_not_confirmed / outline_frozen / upload_incomplete / wrong_state",
  410: "gone (expired after 30 days)",
  413: "too_large (800 pages or 500 MB)",
  415: "unsupported_file",
  422: "outline_invalid / idempotency_mismatch",
  429: "too_many_jobs (see Retry-After)",
};

interface Route {
  method: "get" | "post" | "put";
  path: string;
  summary: string;
  body?: SchemaName;
  ok: { status: number; schema?: SchemaName; description?: string };
  errors: number[];
  idempotent?: boolean;
  query?: { name: string; description: string; enum?: string[] }[];
}

export const ROUTES: Route[] = [
  {
    method: "post",
    path: "/v1/uploads",
    summary: "Start an upload; PUT the file to `upload_url` (resumable).",
    body: "CreateUploadRequest",
    ok: { status: 201, schema: "Upload" },
    errors: [400, 401, 413],
  },
  {
    method: "post",
    path: "/v1/outlines",
    summary:
      "Start a syllabus tree: a tree (or a starting tree with external_ref), or a syllabus to draft one from.",
    body: "CreateOutlineRequest",
    ok: { status: 201, schema: "Outline" },
    errors: [400, 401, 402, 404, 409, 413, 429],
    idempotent: true,
  },
  {
    method: "get",
    path: "/v1/outlines/{id}",
    summary: "Read a tree, with its errors, warnings and drafting progress.",
    ok: { status: 200, schema: "Outline" },
    errors: [401, 404],
  },
  {
    method: "put",
    path: "/v1/outlines/{id}",
    summary: "Replace the draft tree.",
    body: "ReplaceOutlineRequest",
    ok: { status: 200, schema: "Outline" },
    errors: [400, 401, 404, 409],
  },
  {
    method: "post",
    path: "/v1/outlines/{id}/confirm",
    summary: "Freeze the tree. Refused while it has errors.",
    ok: { status: 200, schema: "Outline" },
    errors: [401, 404, 409, 422],
  },
  {
    method: "post",
    path: "/v1/documents",
    summary: "Run a book against a confirmed tree.",
    body: "CreateDocumentRequest",
    ok: { status: 202, schema: "CreatedDocument" },
    errors: [400, 401, 402, 403, 404, 409, 410, 413, 415, 429],
    idempotent: true,
  },
  {
    method: "get",
    path: "/v1/documents/{id}",
    summary: "The document: its status, then its latest revision's result.",
    ok: { status: 200, schema: "Document" },
    errors: [401, 404, 410],
  },
  {
    method: "post",
    path: "/v1/documents/{id}/offset",
    summary: "Confirm or correct where printed page numbers start.",
    body: "ConfirmOffsetRequest",
    ok: { status: 200, schema: "Document" },
    errors: [400, 401, 404, 409, 410],
  },
  {
    method: "post",
    path: "/v1/documents/{id}/revisions",
    summary:
      "Save review's fixes as the next revision (made on `base_revision`).",
    body: "CreateRevisionRequest",
    ok: { status: 201, schema: "Document" },
    errors: [400, 401, 404, 409, 410],
    idempotent: true,
  },
  {
    method: "get",
    path: "/v1/documents/{id}/export",
    summary: "The latest revision as JSON, Excel, a Word sheet or a PDF sheet.",
    ok: { status: 200, description: "The file, as an attachment." },
    errors: [400, 401, 404, 409, 410],
    query: [
      {
        name: "format",
        description: "json (default) | xlsx | docx | pdf",
        enum: ["json", "xlsx", "docx", "pdf"],
      },
    ],
  },
  {
    method: "get",
    path: "/v1/usage",
    summary: "The page-credit balance and ledger.",
    ok: { status: 200, schema: "Usage" },
    errors: [401],
  },
  {
    method: "get",
    path: "/v1/webhook_secret",
    summary: "The secret webhook signatures are made with.",
    ok: { status: 200, schema: "WebhookSecret" },
    errors: [401, 403],
  },
  {
    method: "post",
    path: "/v1/sessions",
    summary:
      "A one-time link to Engines' page, scoped to one outline or document.",
    body: "CreateSessionRequest",
    ok: { status: 201, schema: "Session" },
    errors: [400, 401, 403, 404],
  },
];

const ref = (name: SchemaName) => ({ $ref: `#/components/schemas/${name}` });

function components(): Record<string, unknown> {
  const registry = z.registry<{ id: string }>();
  for (const [id, schema] of Object.entries(SCHEMAS))
    registry.add(schema, { id });
  const { schemas } = z.toJSONSchema(registry, {
    uri: (id) => `#/components/schemas/${id}`,
    // Requests describe what may be sent (defaults optional); responses
    // are the same shapes as returned.
    io: "input",
    unrepresentable: "any",
  });
  return Object.fromEntries(
    // Each schema's own $schema and $id belong to a standalone file, not here.
    Object.entries(schemas).map(([id, schema]) => [
      id,
      Object.fromEntries(
        Object.entries(schema).filter(([k]) => k !== "$schema" && k !== "$id"),
      ),
    ]),
  );
}

export function openApi(version: string): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const route of ROUTES) {
    const parameters = [
      ...[...route.path.matchAll(/\{(\w+)\}/g)].map((m) => ({
        name: m[1],
        in: "path",
        required: true,
        schema: { type: "string" },
      })),
      ...(route.idempotent
        ? [
            {
              name: "Idempotency-Key",
              in: "header",
              required: false,
              description:
                "Run a create at most once per key (24 hours); a repeat returns the same object as it is now.",
              schema: { type: "string" },
            },
          ]
        : []),
      ...(route.query ?? []).map((q) => ({
        name: q.name,
        in: "query",
        required: false,
        description: q.description,
        schema: { type: "string", ...(q.enum ? { enum: q.enum } : {}) },
      })),
    ];
    const responses: Record<string, unknown> = {
      [String(route.ok.status)]: {
        description: route.ok.description ?? "OK",
        ...(route.ok.schema
          ? {
              content: { "application/json": { schema: ref(route.ok.schema) } },
            }
          : {}),
      },
    };
    for (const status of route.errors) {
      responses[String(status)] = {
        description: ERRORS[status] ?? "error",
        content: { "application/json": { schema: ref("Error") } },
      };
    }
    paths[route.path] = {
      ...paths[route.path],
      [route.method]: {
        summary: route.summary,
        ...(parameters.length > 0 ? { parameters } : {}),
        ...(route.body
          ? {
              requestBody: {
                required: true,
                content: { "application/json": { schema: ref(route.body) } },
              },
            }
          : {}),
        responses,
      },
    };
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "Engines",
      version,
      description:
        "A teacher's own book in, questions and explanation out, filed under their syllabus tree. See docs/integrate.md.",
    },
    servers: [{ url: "/" }],
    security: [{ apiKey: [] }],
    paths,
    webhooks: {
      document: {
        post: {
          summary:
            "Sent when a document ends and at each new review revision. Signed: `Engines-Signature: t=<unix>,v1=<hex HMAC-SHA256 of '<t>.<raw body>'>` with the webhook secret.",
          requestBody: {
            content: { "application/json": { schema: ref("WebhookPayload") } },
          },
          responses: { "200": { description: "Any 2xx within 10 seconds." } },
        },
      },
    },
    components: {
      securitySchemes: { apiKey: { type: "http", scheme: "bearer" } },
      schemas: components(),
    },
  };
}
