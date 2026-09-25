import { z } from "zod";

type Env = Record<string, string | undefined>;

const apiEnv = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
});

const databaseEnv = z.object({
  DATABASE_URL: z
    .string({ error: "DATABASE_URL is required" })
    .regex(/^postgres(ql)?:\/\//, "DATABASE_URL must be a postgres:// URL"),
});

export interface ApiConfig {
  port: number;
}

const webhookEnv = z.object({
  WEBHOOK_ALLOW_PRIVATE: z.enum(["true", "false"]).default("false"),
});

/** Local development only: let webhooks reach http:// and private addresses. */
export function readWebhookPolicy(env: Env): { allowPrivate: boolean } {
  return {
    allowPrivate: parse(webhookEnv, env).WEBHOOK_ALLOW_PRIVATE === "true",
  };
}

export interface DatabaseConfig {
  databaseUrl: string;
}

export function readApiConfig(env: Env): ApiConfig {
  const { PORT } = parse(apiEnv, env);
  return { port: PORT };
}

export function readDatabaseConfig(env: Env): DatabaseConfig {
  const { DATABASE_URL } = parse(databaseEnv, env);
  return { databaseUrl: DATABASE_URL };
}

function parse<T extends z.ZodType>(schema: T, env: Env): z.output<T> {
  const result = schema.safeParse(env);
  if (!result.success) {
    throw new Error(`Invalid configuration:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

export type Provider = "openrouter" | "vertex";

/** An optional setting where an empty value (as .env.example leaves them) means unset. */
const optional = z
  .string()
  .optional()
  .transform((v) => (v === "" ? undefined : v));

const aiEnv = z.object({
  AI_MODEL: optional,
  AI_MODEL_CHEAP: optional,
  OPENROUTER_API_KEY: optional,
  VERTEX_PROJECT: optional,
  VERTEX_LOCATION: optional,
});

export interface AiConfig {
  /** Reads pages. */
  model: string | undefined;
  /** Reads printed page numbers in the quick pass. Defaults to `model`. */
  cheapModel: string | undefined;
  openrouterApiKey: string | undefined;
  vertexProject: string | undefined;
  vertexLocation: string | undefined;
}

/** Model settings. Missing values are only an error when a model is actually called. */
export function readAiConfig(env: Env): AiConfig {
  const e = parse(aiEnv, env);
  return {
    model: e.AI_MODEL,
    cheapModel: e.AI_MODEL_CHEAP ?? e.AI_MODEL,
    openrouterApiKey: e.OPENROUTER_API_KEY,
    vertexProject: e.VERTEX_PROJECT,
    vertexLocation: e.VERTEX_LOCATION,
  };
}

const storageEnv = z.discriminatedUnion("STORAGE", [
  z.object({
    STORAGE: z.literal("local"),
    STORAGE_DIR: z.string().default(".data/storage"),
    PUBLIC_URL: z.url().default("http://localhost:8080"),
    LOCAL_STORAGE_SECRET: z
      .string()
      .min(16, "LOCAL_STORAGE_SECRET must be at least 16 characters"),
  }),
  z.object({
    STORAGE: z.literal("gcs"),
    GCS_BUCKET_UPLOADS: z.string().min(1),
    GCS_BUCKET_PAGES: z.string().min(1),
    GCS_BUCKET_RESULTS: z.string().min(1),
    PUBLIC_URL: z.url().optional(),
  }),
]);

export type StorageConfig =
  | { kind: "local"; dir: string; publicUrl: string; secret: string }
  | {
      kind: "gcs";
      buckets: { uploads: string; pages: string; results: string };
      publicUrl: string | undefined;
    };

export function readStorageConfig(env: Env): StorageConfig {
  const e = parse(storageEnv, { STORAGE: "local", ...env });
  if (e.STORAGE === "local") {
    return {
      kind: "local",
      dir: e.STORAGE_DIR,
      publicUrl: e.PUBLIC_URL,
      secret: e.LOCAL_STORAGE_SECRET,
    };
  }
  return {
    kind: "gcs",
    buckets: {
      uploads: e.GCS_BUCKET_UPLOADS,
      pages: e.GCS_BUCKET_PAGES,
      results: e.GCS_BUCKET_RESULTS,
    },
    publicUrl: e.PUBLIC_URL,
  };
}

const workerEnv = z.object({
  PAGE_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(4),
  MODEL_CONCURRENCY: z.coerce.number().int().min(1).max(256).default(8),
  CHUNK_MAX_TOKENS: z.coerce.number().int().min(50).default(800),
  CHUNK_MIN_TOKENS: z.coerce.number().int().min(0).default(60),
});

export interface WorkerConfig {
  pageConcurrency: number;
  /** Model calls one worker makes at once, across every key (E-13). */
  modelConcurrency: number;
  /** Explanation chunk sizes, in estimated tokens (E-12). */
  chunking: { maxTokens: number; minTokens: number };
}

export function readWorkerConfig(env: Env): WorkerConfig {
  const e = parse(workerEnv, env);
  return {
    pageConcurrency: e.PAGE_CONCURRENCY,
    modelConcurrency: e.MODEL_CONCURRENCY,
    chunking: { maxTokens: e.CHUNK_MAX_TOKENS, minTokens: e.CHUNK_MIN_TOKENS },
  };
}

const exportEnv = z.object({ CHROMIUM_PATH: optional });

/** Where headless Chromium is, for PDF exports (found on the usual paths when unset). */
export function readExportConfig(env: Env): {
  chromiumPath: string | undefined;
} {
  return { chromiumPath: parse(exportEnv, env).CHROMIUM_PATH };
}

const authEnv = z.object({
  PUBLIC_URL: z.url().default("http://localhost:8080"),
  AUTH_SECRET: z
    .string({ error: "AUTH_SECRET is required" })
    .min(32, "AUTH_SECRET must be at least 32 characters"),
  GOOGLE_CLIENT_ID: optional,
  GOOGLE_CLIENT_SECRET: optional,
  AUTH_TRUSTED_ORIGINS: optional,
});

export interface AuthSettings {
  baseURL: string;
  secret: string;
  google: { clientId: string; clientSecret: string } | undefined;
  trustedOrigins: string[];
}

/** Sign-in on Engines' page (E-15). Google sign-in is on when both of its settings are. */
export function readAuthConfig(env: Env): AuthSettings {
  const e = parse(authEnv, env);
  return {
    baseURL: e.PUBLIC_URL,
    secret: e.AUTH_SECRET,
    google:
      e.GOOGLE_CLIENT_ID && e.GOOGLE_CLIENT_SECRET
        ? { clientId: e.GOOGLE_CLIENT_ID, clientSecret: e.GOOGLE_CLIENT_SECRET }
        : undefined,
    trustedOrigins: (e.AUTH_TRUSTED_ORIGINS ?? "")
      .split(",")
      .map((o) => o.trim())
      .filter((o) => o !== ""),
  };
}
