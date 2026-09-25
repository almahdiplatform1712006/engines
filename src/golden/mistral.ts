// Mistral OCR, for the reading trial (E-06): typed blocks with boxes,
// header/footer and page-number blocks. The response is read defensively:
// newer models return `blocks`; without them, only the page's images have
// boxes. Check the field names against Mistral's current docs before the run.
import type { Layout, LayoutRegion, LayoutSource } from "./layout.ts";

export interface MistralOptions {
  key: string;
  /** The OCR model id, such as the current OCR 4 model's. Config, never hard-coded. */
  model: string;
  /** USD per page, from Mistral's price list. */
  pricePerPage: number;
  fetch?: typeof fetch;
}

interface OcrPage {
  dimensions?: { width: number; height: number };
  blocks?: {
    type?: string;
    text?: string;
    content?: string;
    bbox?: {
      top_left_x: number;
      top_left_y: number;
      bottom_right_x: number;
      bottom_right_y: number;
    };
  }[];
  images?: {
    top_left_x: number;
    top_left_y: number;
    bottom_right_x: number;
    bottom_right_y: number;
  }[];
}

export function mistralOcr(options: MistralOptions): LayoutSource {
  const doFetch = options.fetch ?? fetch;
  return {
    name: `mistral:${options.model}`,
    async analyze(png) {
      const response = await doFetch("https://api.mistral.ai/v1/ocr", {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.key}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: options.model,
          document: {
            type: "image_url",
            image_url: `data:image/png;base64,${Buffer.from(png).toString("base64")}`,
          },
        }),
      });
      if (!response.ok)
        throw new Error(
          `Mistral refused the page (${String(response.status)})`,
        );
      const body = (await response.json()) as { pages?: OcrPage[] };
      return toLayout(body.pages?.[0] ?? {}, options.pricePerPage);
    },
  };
}

export function toLayout(page: OcrPage, pricePerPage: number): Layout {
  const width = page.dimensions?.width ?? 1;
  const height = page.dimensions?.height ?? 1;
  const box = (b: {
    top_left_x: number;
    top_left_y: number;
    bottom_right_x: number;
    bottom_right_y: number;
  }) => ({
    x: b.top_left_x / width,
    y: b.top_left_y / height,
    w: (b.bottom_right_x - b.top_left_x) / width,
    h: (b.bottom_right_y - b.top_left_y) / height,
  });
  const regions: LayoutRegion[] = [];
  let pageNumber: string | null = null;
  for (const block of page.blocks ?? []) {
    const text = block.text ?? block.content ?? "";
    const role = block.type ?? null;
    if (role === "page_number" || role === "pageNumber") pageNumber = text;
    if (block.bbox)
      regions.push({
        text,
        box: box(block.bbox),
        role: role === "page_number" ? "pageNumber" : role,
      });
  }
  for (const image of page.images ?? [])
    regions.push({ text: "", box: box(image), role: "image" });
  return { pageNumber, regions, costUsd: pricePerPage };
}
