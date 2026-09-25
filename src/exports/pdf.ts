// Prints the worksheet's HTML to PDF with headless Chromium (spec §5 Exports),
// which shapes Arabic right-to-left correctly. Chromium runs as a separate
// process; CHROMIUM_PATH names the binary.
import { access } from "node:fs/promises";
import { chromium } from "playwright-core";

const CANDIDATES = [
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/opt/pw-browsers/chromium",
];

export async function chromiumPath(
  configured: string | undefined,
): Promise<string> {
  for (const path of configured ? [configured] : CANDIDATES) {
    try {
      await access(path);
      return path;
    } catch {
      // try the next
    }
  }
  throw new Error("No Chromium found for PDF exports; set CHROMIUM_PATH");
}

export async function htmlToPdf(
  html: string,
  executablePath: string,
): Promise<Buffer> {
  const browser = await chromium.launch({
    executablePath,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "load" });
    return await page.pdf({
      format: "A4",
      printBackground: true,
      preferCSSPageSize: true,
    });
  } finally {
    await browser.close();
  }
}
