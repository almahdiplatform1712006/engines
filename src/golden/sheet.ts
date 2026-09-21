// The correction sheet: a local HTML page that shows each golden page image next
// to its draft truth, so the owner can fix the draft and save it as corrected.
// It links the images (never embeds them) and is git-ignored.
import { writeFile } from "node:fs/promises";
import { bookPaths, loadManifest, loadTruth } from "./book.ts";
import type { PageTruth } from "./truth.ts";

export async function writeCorrectionSheet(
  root: string,
  book: string,
): Promise<string> {
  const manifest = await loadManifest(root, book);
  const sections: string[] = [];
  for (const page of manifest.pages) {
    const truth: PageTruth = (await loadTruth(root, book, page.id)) ?? {
      status: "draft",
      pdf_page: page.pdf_page,
      printed_page: null,
      stimuli: [],
      questions: [],
      explanation: [],
    };
    sections.push(`<section class="page" data-page="${escape(page.id)}">
  <figure>
    <img src="images/${escape(encodeURIComponent(page.image))}" alt="${escape(page.id)}" loading="lazy">
    <figcaption>${escape(page.id)} · PDF page ${String(page.pdf_page)}</figcaption>
  </figure>
  <div class="editor">
    <p class="status" data-status="${truth.status}">${truth.status}</p>
    <textarea dir="auto" spellcheck="false">${escape(JSON.stringify(truth, null, 2))}</textarea>
    <p class="actions">
      <button type="button" data-save="draft">Save draft</button>
      <button type="button" data-save="corrected">Save as corrected</button>
      <span class="message" role="status"></span>
    </p>
  </div>
</section>`);
  }

  const path = bookPaths(root, book).sheet;
  await writeFile(path, page(manifest.title, book, sections.join("\n")));
  return path;
}

function escape(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function page(title: string, book: string, body: string): string {
  return `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<title>${escape(title)} — golden truth</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 0; padding: 16px; background: #f6f6f4; color: #1d1d1b; }
  header { margin-block-end: 16px; }
  .page { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 16px; background: #fff;
          padding: 16px; margin-block-end: 24px; border: 1px solid #ddd; border-radius: 8px; }
  figure { margin: 0; }
  img { inline-size: 100%; block-size: auto; border: 1px solid #ccc; cursor: zoom-in; }
  img.zoomed { inline-size: 200%; cursor: zoom-out; }
  figure { overflow: auto; max-block-size: 90vh; position: sticky; inset-block-start: 16px; }
  textarea { inline-size: 100%; min-block-size: 70vh; font: 13px/1.5 ui-monospace, monospace; box-sizing: border-box; }
  .status[data-status="corrected"] { color: #1a7f37; font-weight: bold; }
  .status[data-status="draft"] { color: #9a6700; font-weight: bold; }
  .message { margin-inline-start: 8px; }
  .message.error { color: #cf222e; }
  @media (max-width: 800px) { .page { grid-template-columns: 1fr; } figure { position: static; } }
</style>
</head>
<body>
<header>
  <h1>${escape(title)}</h1>
  <p dir="ltr">Book <code>${escape(book)}</code>. Fix each draft to match the page, then “Save as corrected”.
  In Chrome or Edge the first save asks for this book's <code>truth/</code> folder and writes into it;
  other browsers download <code>&lt;page&gt;.json</code> for you to move into <code>truth/</code>.
  <code>npm run golden:score</code> checks every file against the format.</p>
</header>
${body}
<script>
  let truthDir = null;

  async function save(pageId, json) {
    const text = JSON.stringify(json, null, 2) + "\\n";
    if ("showDirectoryPicker" in window) {
      truthDir ??= await window.showDirectoryPicker({ id: "golden-truth", mode: "readwrite" });
      const file = await truthDir.getFileHandle(pageId + ".json", { create: true });
      const writable = await file.createWritable();
      await writable.write(text);
      await writable.close();
      return "saved to truth/" + pageId + ".json";
    }
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    link.download = pageId + ".json";
    link.click();
    URL.revokeObjectURL(link.href);
    return "downloaded " + pageId + ".json";
  }

  document.addEventListener("click", async (event) => {
    const target = event.target;
    if (target instanceof HTMLImageElement) target.classList.toggle("zoomed");
    if (!(target instanceof HTMLButtonElement) || !target.dataset.save) return;

    const section = target.closest(".page");
    const textarea = section.querySelector("textarea");
    const message = section.querySelector(".message");
    const status = section.querySelector(".status");
    message.className = "message";
    try {
      const json = JSON.parse(textarea.value);
      json.status = target.dataset.save;
      message.textContent = await save(section.dataset.page, json);
      textarea.value = JSON.stringify(json, null, 2);
      status.textContent = status.dataset.status = json.status;
    } catch (error) {
      message.className = "message error";
      message.textContent = String(error);
    }
  });
</script>
</body>
</html>
`;
}
