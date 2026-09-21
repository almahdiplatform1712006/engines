// The page reader the golden tools run. The model reader arrives with the reading
// tickets (E-05/E-06) and registers here; until then only the stub exists.
import type { PageContent, Usage } from "./truth.ts";

export interface PageImage {
  /** Path to the page image on disk. */
  path: string;
  pdf_page: number;
}

export interface PageReading {
  content: PageContent;
  usage: Usage;
}

export interface PageReader {
  readonly name: string;
  read(image: PageImage): Promise<PageReading>;
}

/**
 * Reads nothing and costs nothing: an empty page for the owner to fill in. Used
 * where no model reader or key is available, and in tests.
 */
export const stubReader: PageReader = {
  name: "stub",
  read(image) {
    return Promise.resolve({
      content: {
        pdf_page: image.pdf_page,
        printed_page: null,
        stimuli: [],
        questions: [],
        explanation: [],
      },
      usage: { input_tokens: 0, output_tokens: 0, cost_usd: 0 },
    });
  },
};

const readers: Record<string, PageReader> = { stub: stubReader };

/** The reader named by `GOLDEN_READER`, defaulting to the stub. */
export function selectReader(
  env: Record<string, string | undefined>,
): PageReader {
  const name = env["GOLDEN_READER"] ?? "stub";
  const reader = readers[name];
  if (reader === undefined) {
    throw new Error(
      `GOLDEN_READER="${name}" is not a page reader. Available: ${Object.keys(readers).join(", ")}`,
    );
  }
  return reader;
}
