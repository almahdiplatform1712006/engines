// The page reader the golden tools run: the stub, or Engines' own model reader
// (`GOLDEN_READER=model`, using AI_MODEL on OpenRouter).
import { createModelReader } from "../reading/model.ts";
import { languageModel } from "../reading/providers.ts";
import { readAiConfig } from "../shared/config.ts";
import { azureLayout, type AzureOptions } from "./azure.ts";
import { goldenReader } from "./engine-reader.ts";
import { withLayout, type LayoutSource } from "./layout.ts";
import { mistralOcr, type MistralOptions } from "./mistral.ts";
import { emptyPage, type PageContent, type Usage } from "./truth.ts";

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
      content: emptyPage(image.pdf_page),
      usage: { input_tokens: 0, output_tokens: 0, cost_usd: 0 },
    });
  },
};

const readers: Record<
  string,
  (env: Record<string, string | undefined>) => PageReader
> = {
  stub: () => stubReader,
  model: (env) => {
    const ai = readAiConfig(env);
    return goldenReader(`model:${ai.model ?? "?"}`, (record) =>
      createModelReader({
        main: languageModel(ai, "openrouter", "main"),
        record,
      }),
    );
  },
  // The reading trial's set-ups 2 and 3 (E-06): the model, plus an add-on's
  // page numbers and boxes.
  "model+azure": (env) => withAddOn(env, azureLayout(azureOptions(env))),
  "model+mistral": (env) => withAddOn(env, mistralOcr(mistralOptions(env))),
};

function withAddOn(
  env: Record<string, string | undefined>,
  source: LayoutSource,
): PageReader {
  const ai = readAiConfig(env);
  return goldenReader(`model:${ai.model ?? "?"}+${source.name}`, (record) =>
    withLayout(
      createModelReader({
        main: languageModel(ai, "openrouter", "main"),
        record,
      }),
      source,
      record,
    ),
  );
}

function required(env: Record<string, string | undefined>, name: string) {
  const value = env[name];
  if (!value) throw new Error(`${name} is required for this trial set-up`);
  return value;
}

function azureOptions(env: Record<string, string | undefined>): AzureOptions {
  return {
    endpoint: required(env, "AZURE_DI_ENDPOINT"),
    key: required(env, "AZURE_DI_KEY"),
    pricePerPage: Number(required(env, "AZURE_DI_PRICE_PER_PAGE")),
  };
}

function mistralOptions(
  env: Record<string, string | undefined>,
): MistralOptions {
  return {
    key: required(env, "MISTRAL_API_KEY"),
    model: required(env, "MISTRAL_OCR_MODEL"),
    pricePerPage: Number(required(env, "MISTRAL_OCR_PRICE_PER_PAGE")),
  };
}

/** The reader named by `GOLDEN_READER`, defaulting to the stub. */
export function selectReader(
  env: Record<string, string | undefined>,
): PageReader {
  const name = env["GOLDEN_READER"] ?? "stub";
  const make = readers[name];
  if (make === undefined) {
    throw new Error(
      `GOLDEN_READER="${name}" is not a page reader. Available: ${Object.keys(readers).join(", ")}`,
    );
  }
  return make(env);
}
