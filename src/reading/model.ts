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
import type { z } from "zod";
import { ModelPage, toPageReading } from "./blocks.ts";
import { READ_PAGE } from "./prompts.ts";
import type {
  CallContext,
  ModelCall,
  PageReader,
  RecordCall,
} from "./reader.ts";

export interface ModelReaderOptions {
  /** The model that reads pages. */
  model: LanguageModel;
  /** Its name, for the log. The name itself comes from config (never a call site). */
  modelName: string;
  record: RecordCall;
  /**
   * Output-token limits to try in turn. A call that stops on `length` is tried
   * again with the next limit rather than salvage-parsed (E-05).
   */
  outputTokenSteps?: readonly number[];
}

const DEFAULT_STEPS = [16_000, 32_000] as const;

export class TruncatedOutputError extends Error {
  override name = "TruncatedOutputError";
}

export function createModelReader(options: ModelReaderOptions): PageReader {
  const steps = options.outputTokenSteps ?? DEFAULT_STEPS;

  async function call<S extends z.ZodType>(
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
        model: options.modelName,
      };
      try {
        const result = await generateText({
          model: options.model,
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
    async readPage(image, context) {
      const page = await call(
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
