import { serve } from "@hono/node-server";
import { readApiConfig } from "../shared/config.ts";
import { createApp } from "./app.ts";

const { port } = readApiConfig(process.env);

const server = serve({ fetch: createApp().fetch, port }, (info) => {
  console.log(`api listening on :${String(info.port)}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    server.close((error) => {
      if (error) console.error(error);
      process.exit(error ? 1 : 0);
    });
  });
}
