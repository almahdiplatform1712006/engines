// Test helpers for the model seam: block builders and a mock language model.
import { MockLanguageModelV4 } from "ai/test";
import type { ModelBlock, ModelPage } from "../src/reading/blocks.ts";

/** A model block with every field empty, overridden by `fields`. */
export function modelBlock(
  fields: Partial<ModelBlock> & Pick<ModelBlock, "kind">,
): ModelBlock {
  return {
    text: "",
    box_2d: null,
    continues: false,
    continued_from: false,
    confidence: 0.9,
    math_direction: null,
    question_number: null,
    question_type: null,
    options: [],
    marked: [],
    needs_figure: false,
    stimulus_label: null,
    stimulus_kind: null,
    label: null,
    covers: null,
    answers: [],
    ...fields,
  };
}

/** A multiple-choice question block. */
export function mcq(
  number: string,
  text: string,
  keys = ["أ", "ب", "ج", "د"],
): ModelBlock {
  return modelBlock({
    kind: "question",
    text,
    question_number: number,
    question_type: "multiple_choice",
    options: keys.map((key) => ({ key, text: `${text} ${key}` })),
  });
}

export function page(printed: string | null, blocks: ModelBlock[]): ModelPage {
  return { printed_page: printed, blocks };
}

export interface MockReply {
  text: string;
  finishReason?: "stop" | "length";
  outputTokens?: number;
}

/** A mock model that answers with `replies` in turn (the last one repeats). */
export function mockModel(replies: MockReply[]): MockLanguageModelV4 {
  let call = 0;
  return new MockLanguageModelV4({
    modelId: "mock-model",
    doGenerate: () => {
      const reply = replies[Math.min(call++, replies.length - 1)];
      if (!reply) throw new Error("mockModel needs at least one reply");
      return Promise.resolve({
        content: [{ type: "text", text: reply.text }],
        finishReason: { unified: reply.finishReason ?? "stop", raw: undefined },
        usage: {
          inputTokens: {
            total: 1000,
            noCache: 1000,
            cacheRead: undefined,
            cacheWrite: undefined,
          },
          outputTokens: {
            total: reply.outputTokens ?? 200,
            text: reply.outputTokens ?? 200,
            reasoning: undefined,
          },
        },
        warnings: [],
      });
    },
  });
}
