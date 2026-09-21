import { Hono } from "hono";

export function createApp(): Hono {
  const app = new Hono();

  app.get("/v1/health", (c) => c.json({ status: "ok" }));

  return app;
}
