// The built page in a real browser, served over HTTP by the whole stack.
// Needs `npm run build:web` first and a Chromium (the one PDF exports use).
import { serve } from "@hono/node-server";
import { createServer, type AddressInfo } from "node:net";
import { existsSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright-core";
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

/** A signed-in page at 400 px for a new person and organisation. */
export async function signedIn(
  p: PageHarness,
  email: string,
  organisation = "مدرسة",
): Promise<{ page: Page; orgId: string }> {
  const context = await p.browser.newContext({
    viewport: { width: 400, height: 900 },
    baseURL: p.url,
  });
  const headers = { origin: p.url };
  const signUp = await context.request.post("/api/auth/sign-up/email", {
    headers,
    data: { email, password: "a long enough password", name: email },
  });
  if (!signUp.ok()) throw new Error(`sign-up: ${await signUp.text()}`);
  const org = await context.request.post("/api/auth/organization/create", {
    headers,
    data: { name: organisation, slug: `org-${String(Date.now())}` },
  });
  if (!org.ok()) throw new Error(`organisation: ${await org.text()}`);
  const { id } = (await org.json()) as { id: string };
  return { page: await context.newPage(), orgId: id };
}

/** Fails when anything on the page is wider than the window. */
export async function assertFitsWidth(page: Page): Promise<void> {
  // A string, so the root tsconfig (no DOM types) doesn't check browser code.
  const overflow = await page.evaluate<number>(
    "document.documentElement.scrollWidth - window.innerWidth",
  );
  if (overflow > 0) {
    throw new Error(`${page.url()} spills ${String(overflow)}px sideways`);
  }
  const dir = process.env["SCREENSHOT_DIR"];
  if (dir) {
    const name = `${String(Date.now())}-${new URL(page.url()).pathname.replace(/\W+/g, "_")}.png`;
    await page.screenshot({ path: `${dir}/${name}`, fullPage: true });
  }
}
