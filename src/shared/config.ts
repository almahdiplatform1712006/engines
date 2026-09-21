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
