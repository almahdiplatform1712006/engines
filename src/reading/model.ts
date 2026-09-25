// The model adapter behind PageReader: Vercel AI SDK `generateText` with
// `Output.object` and the Zod schemas in blocks.ts (spec #1 §5).
import {
  generateText,
  NoObjectGeneratedError,
  Output,
  type LanguageModel,
  type UserContent,
  type ProviderMetadata,
} from "ai";
import { z } from "zod";
import { ModelBlock, ModelPage, toBlock, toPageReading } from "./blocks.ts";
import { READ_NUMBER, READ_PAGE, readPair } from "./prompts.ts";
import type {
  CallContext,
  ModelCall,
  PageReader,
  RecordCall,
} from "./reader.ts";

/** A model and its name for the log. The name itself comes from config, never a call site. */
export interface NamedModel {
  model: LanguageModel;
  name: string;
}

export interface ModelReaderOptions {
  /** Reads pages. */
  main: NamedModel;
  /** Reads printed page numbers in the quick pass. Defaults to `main`. */
  cheap?: NamedModel;
  record: RecordCall;
  /**
   * Output-token limits to try in turn. A call that stops on `length` is tried
   * again with the next limit rather than salvage-parsed (E-05).
   */
  outputTokenSteps?: readonly number[];
}

const DEFAULT_STEPS = [16_000, 32_000] as const;

/** One object with both pages, so the model can't answer with two JSON objects. */
const PairPages = z.object({
  pages: z.array(z.object({ page: z.int(), blocks: z.array(ModelBlock) })),
});

export class NoJoinedBlockError extends Error {
  override name = "NoJoinedBlockError";
}

const PrintedNumber = z.object({
  printed_page: z
    .string()
    .nullable()
    .describe("The printed page number exactly as printed, or null"),
});

export class TruncatedOutputError extends Error {
  override name = "TruncatedOutputError";
}

export function createModelReader(options: ModelReaderOptions): PageReader {
  const steps = options.outputTokenSteps ?? DEFAULT_STEPS;

  const cheap = options.cheap ?? options.main;

  async function call<S extends z.ZodType>(
    named: NamedModel,
    purpose: ModelCall["purpose"],
    pdfPage: number | null,
    context: CallContext,
    schema: S,
    instructions: string,
    content: UserContent,
  ): Promise<z.output<S>> {
    for (const maxOutputTokens of steps) {
      const base = {
        context,
        purpose,
        pdfPage,
        model: named.name,
      };
      try {
        const result = await generateText({
          model: named.model,
          output: Output.object({ schema }),
          instructions,
          messages: [{ role: "user", content }],
          maxOutputTokens,
          temperature: 0,
        });
        await options.record({
          ...base,
          finishReason: result.finishReason,
          inputTokens: result.usage.inputTokens ?? 0,
          outputTokens: result.usage.outputTokens ?? 0,
          costUsd: costOf(result.finalStep.providerMetadata),
          ok: true,
          error: null,
        });
        return result.output as z.output<S>;
      } catch (error) {
        if (!NoObjectGeneratedError.isInstance(error)) {
          await options.record({
            ...base,
            finishReason: null,
            inputTokens: 0,
            outputTokens: 0,
            costUsd: 0,
            ok: false,
            error: String(error),
          });
          throw error;
        }
        await options.record({
          ...base,
          finishReason: error.finishReason ?? null,
          inputTokens: error.usage?.inputTokens ?? 0,
          outputTokens: error.usage?.outputTokens ?? 0,
          costUsd: 0,
          ok: false,
          error: error.message,
        });
        if (error.finishReason !== "length") throw error;
      }
    }
    throw new TruncatedOutputError(
      `${purpose}: output still cut off at ${String(steps.at(-1))} tokens`,
    );
  }

  return {
    async readPrintedNumber(image, context) {
      const { printed_page } = await call(
        cheap,
        "read_number",
        image.pdfPage,
        context,
        PrintedNumber,
        READ_NUMBER,
        [{ type: "image", image: image.bytes, mediaType: image.mediaType }],
      );
      return printed_page;
    },
    async readPair(images, halves, context) {
      const [firstImage, secondImage] = images;
      const [first, second] = halves;
      const { pages } = await call(
        options.main,
        "read_pair",
        firstImage.pdfPage,
        context,
        PairPages,
        [
          READ_PAGE,
          readPair(
            { page: first.pdf_page, kind: first.kind, text: first.text },
            { page: second.pdf_page, text: second.text },
          ),
        ].join("\n\n"),
        [
          {
            type: "image",
            image: firstImage.bytes,
            mediaType: firstImage.mediaType,
          },
          {
            type: "image",
            image: secondImage.bytes,
            mediaType: secondImage.mediaType,
          },
        ],
      );
      const joined =
        pages.find((p) => p.page === first.pdf_page)?.blocks[0] ??
        pages.flatMap((p) => p.blocks)[0];
      if (!joined)
        throw new NoJoinedBlockError(
          `pair ${first.id} + ${second.id}: no joined block returned`,
        );
      return toBlock(first.pdf_page, first.order, joined);
    },
    async readPage(image, context) {
      const page = await call(
        options.main,
        "read_page",
        image.pdfPage,
        context,
        ModelPage,
        READ_PAGE,
        [{ type: "image", image: image.bytes, mediaType: image.mediaType }],
      );
      return toPageReading(image.pdfPage, page);
    },
  };
}

/** OpenRouter reports the call's cost when usage accounting is on. */
function costOf(metadata: ProviderMetadata | undefined): number {
  const usage = metadata?.["openrouter"]?.["usage"];
  if (usage && typeof usage === "object" && "cost" in usage) {
    const cost = (usage as { cost?: unknown }).cost;
    if (typeof cost === "number") return cost;
  }
  return 0;
}
