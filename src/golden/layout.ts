// The reading trial's layout add-ons (E-06, decision Q21). The model still
// reads, labels and structures every page; an add-on supplies what it would
// be bought for: the printed page number and block boxes. Trial code only:
// nothing here is wired into the pipeline unless the owner adopts it.
import type { CropBox } from "../contract/crop.ts";
import type { PageReading } from "../reading/blocks.ts";
import type { PageReader, RecordCall } from "../reading/reader.ts";
import { parsePrintedNumber } from "../shared/text.ts";
import { similarity } from "./arabic.ts";

/** One region an add-on found on a page. */
export interface LayoutRegion {
  text: string;
  box: CropBox;
  /** The add-on's own label: pageNumber, sectionHeading, pageHeader, … */
  role: string | null;
}

export interface Layout {
  /** The printed page number the add-on found, as printed. */
  pageNumber: string | null;
  regions: LayoutRegion[];
  /** What this page cost at the add-on's price. */
  costUsd: number;
}

export interface LayoutSource {
  readonly name: string;
  analyze(png: Uint8Array): Promise<Layout>;
}

/** How alike a block's text and a region's must be for the region's box to count. */
const MATCH = 0.5;

/**
 * The model's reading, with the add-on's page number (when it found one) and,
 * for each block, the box of the region whose text matches it best.
 */
export function mergeLayout(reading: PageReading, layout: Layout): PageReading {
  const number = parsePrintedNumber(layout.pageNumber);
  return {
    ...reading,
    printed_number: number ?? reading.printed_number,
    blocks: reading.blocks.map((block) => {
      let best: { region: LayoutRegion; score: number } | null = null;
      for (const region of layout.regions) {
        if (region.role === "pageNumber" || block.text.trim() === "") continue;
        const score = similarity(block.text, region.text);
        if (score >= MATCH && (best === null || score > best.score))
          best = { region, score };
      }
      return best ? { ...block, box: best.region.box } : block;
    }),
  };
}

/** A page reader that runs the add-on beside the model and merges the two. */
export function withLayout(
  reader: PageReader,
  source: LayoutSource,
  record: RecordCall,
): PageReader {
  return {
    ...reader,
    async readPage(image, context) {
      const [reading, layout] = await Promise.all([
        reader.readPage(image, context),
        source.analyze(image.bytes),
      ]);
      // Logged like a model call, so cost per page includes the add-on.
      await record({
        context,
        purpose: "read_page",
        pdfPage: image.pdfPage,
        model: source.name,
        finishReason: null,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: layout.costUsd,
        ok: true,
        error: null,
      });
      return mergeLayout(reading, layout);
    },
  };
}

/** A box from a polygon's corners (x1, y1, x2, y2, …) in page units. */
export function boxFromPolygon(
  polygon: readonly number[],
  width: number,
  height: number,
): CropBox {
  const xs = polygon.filter((_, i) => i % 2 === 0);
  const ys = polygon.filter((_, i) => i % 2 === 1);
  const clamp = (v: number) => Math.min(Math.max(v, 0), 1);
  const x = clamp(Math.min(...xs) / width);
  const y = clamp(Math.min(...ys) / height);
  return {
    x,
    y,
    w: clamp(Math.max(...xs) / width) - x,
    h: clamp(Math.max(...ys) / height) - y,
  };
}
