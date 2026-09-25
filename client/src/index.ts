// @engines/client: a typed client for Engines' `/v1/` API (E-21). The types
// come from openapi.json (schema.ts, generated); this file is the calls.
import type {
  ConfirmOffsetRequest,
  CreatedDocument,
  CreateDocumentRequest,
  CreateOutlineRequest,
  CreateRevisionRequest,
  CreateSessionRequest,
  CreateUploadRequest,
  Document,
  Error as ErrorBody,
  Outline,
  OutlineNodeInput,
  Session,
  Upload,
  Usage,
  WebhookSecret,
} from "./schema.ts";

export type * from "./schema.ts";
export {
  DEFAULT_TOLERANCE_SECONDS,
  SIGNATURE_HEADER,
  verifyWebhook,
  type VerifyOptions,
} from "./webhook.ts";

export interface ClientOptions {
  /** Where Engines is, such as https://engines.example. */
  baseUrl: string;
  /** An API key from Engines' page. */
  apiKey: string;
  /** A fetch to use instead of the global one. */
  fetch?: typeof fetch;
}

/** A refusal from Engines: its HTTP status, code, message and details. */
export class EnginesError extends Error {
  override name = "EnginesError";
  readonly status: number;
  readonly code: string;
  readonly details: unknown;
  /** Seconds to wait, for `too_many_jobs` (429). */
  readonly retryAfter: number | null;

  constructor(
    status: number,
    body: ErrorBody | null,
    retryAfter: number | null,
  ) {
    super(body?.error.message ?? `Engines answered ${String(status)}`);
    this.status = status;
    this.code = body?.error.code ?? "unknown";
    this.details = body?.error.details;
    this.retryAfter = retryAfter;
  }
}

export interface CreateOptions {
  /** Makes the create happen at most once per key (24 hours). */
  idempotencyKey?: string;
}

export type ExportFormat = "json" | "xlsx" | "docx" | "pdf";

export function createClient(options: ClientOptions) {
  const doFetch = options.fetch ?? fetch;
  const base = options.baseUrl.replace(/\/$/, "");

  async function send(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    const response = await doFetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${options.apiKey}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      const error = (await response
        .json()
        .catch(() => null)) as ErrorBody | null;
      const retry = response.headers.get("retry-after");
      throw new EnginesError(
        response.status,
        error,
        retry === null ? null : Number(retry),
      );
    }
    return response;
  }
  const json = async <T>(
    method: string,
    path: string,
    body?: unknown,
    create?: CreateOptions,
  ): Promise<T> => {
    const headers: Record<string, string> = create?.idempotencyKey
      ? { "idempotency-key": create.idempotencyKey }
      : {};
    return (await (await send(method, path, body, headers)).json()) as T;
  };
  const id = (value: string) => encodeURIComponent(value);

  return {
    uploads: {
      create: (body: CreateUploadRequest) =>
        json<Upload>("POST", "/v1/uploads", body),
      /**
       * Uploads a whole file in one request: `POST /v1/uploads`, then the
       * bytes to its upload URL. Returns the upload id.
       */
      async upload(
        bytes: Uint8Array | Blob,
        file: {
          filename: string;
          contentType: CreateUploadRequest["content_type"];
        },
      ): Promise<string> {
        const size = bytes instanceof Blob ? bytes.size : bytes.byteLength;
        const upload = await json<Upload>("POST", "/v1/uploads", {
          filename: file.filename,
          content_type: file.contentType,
          size,
        });
        const put = await doFetch(upload.upload_url, {
          method: "PUT",
          body:
            bytes instanceof Blob
              ? bytes
              : new Blob([bytes as Uint8Array<ArrayBuffer>]),
        });
        if (!put.ok) throw new EnginesError(put.status, null, null);
        return upload.id;
      },
    },
    outlines: {
      create: (body: CreateOutlineRequest, create?: CreateOptions) =>
        json<Outline>("POST", "/v1/outlines", body, create),
      get: (outlineId: string) =>
        json<Outline>("GET", `/v1/outlines/${id(outlineId)}`),
      replace: (outlineId: string, nodes: OutlineNodeInput[]) =>
        json<Outline>("PUT", `/v1/outlines/${id(outlineId)}`, { nodes }),
      confirm: (outlineId: string) =>
        json<Outline>("POST", `/v1/outlines/${id(outlineId)}/confirm`),
    },
    documents: {
      create: (body: CreateDocumentRequest, create?: CreateOptions) =>
        json<CreatedDocument>("POST", "/v1/documents", body, create),
      get: (documentId: string) =>
        json<Document>("GET", `/v1/documents/${id(documentId)}`),
      confirmOffset: (documentId: string, body: ConfirmOffsetRequest) =>
        json<Document>("POST", `/v1/documents/${id(documentId)}/offset`, body),
      revise: (
        documentId: string,
        body: CreateRevisionRequest,
        create?: CreateOptions,
      ) =>
        json<Document>(
          "POST",
          `/v1/documents/${id(documentId)}/revisions`,
          body,
          create,
        ),
      /** The latest revision as a file. */
      async export(
        documentId: string,
        format: ExportFormat,
      ): Promise<Uint8Array> {
        const response = await send(
          "GET",
          `/v1/documents/${id(documentId)}/export?format=${format}`,
        );
        return new Uint8Array(await response.arrayBuffer());
      },
    },
    sessions: {
      create: (body: CreateSessionRequest) =>
        json<Session>("POST", "/v1/sessions", body),
    },
    usage: () => json<Usage>("GET", "/v1/usage"),
    webhookSecret: () => json<WebhookSecret>("GET", "/v1/webhook_secret"),
  };
}

export type EnginesClient = ReturnType<typeof createClient>;
