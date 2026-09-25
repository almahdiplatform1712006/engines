// The built page in a real browser, served over HTTP by the whole stack.
// Needs `npm run build:web` first and a Chromium (the one PDF exports use).
import { serve } from "@hono/node-server";
import { createServer, type AddressInfo } from "node:net";
import { existsSync } from "node:fs";
import { chromium, type Browser } from "playwright-core";
import { chromiumPath } from "../src/exports/pdf.ts";
import { scriptedReader } from "../src/reading/scripted.ts";
import { startHarness, type Harness, type HarnessOptions } from "./harness.ts";

const WEB_DIR = "web/dist";

export interface PageHarness {
  h: Harness;
  url: string;
  browser: Browser;
  close(): Promise<void>;
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

export async function startPage(
  options: Partial<HarnessOptions> = {},
): Promise<PageHarness> {
  if (!existsSync(`${WEB_DIR}/index.html`)) {
    throw new Error("Build the page first: npm run build:web");
  }
  const port = await freePort();
  const url = `http://127.0.0.1:${String(port)}`;
  const h = await startHarness({
    reader: () => scriptedReader({ pages: {} }),
    ...options,
    webDir: WEB_DIR,
    publicUrl: url,
  });
  const server = serve({ fetch: h.app.fetch, port, hostname: "127.0.0.1" });
  const browser = await chromium.launch({
    executablePath: await chromiumPath(process.env["CHROMIUM_PATH"]),
  });
  return {
    h,
    url,
    browser,
    async close() {
      await browser.close();
      await new Promise((resolve) => server.close(resolve));
      await h.close();
    },
  };
}
