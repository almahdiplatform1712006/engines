// Builds the language model for a provider from config (spec decision Q22: one
// provider setting per API key). The model name is always config.
import { createVertex } from "@ai-sdk/google-vertex";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModel } from "ai";
import type { AiConfig, Provider } from "../shared/config.ts";

export interface NamedModel {
  model: LanguageModel;
  name: string;
}

export type Tier = "main" | "cheap";

export function languageModel(
  config: AiConfig,
  provider: Provider,
  tier: Tier,
): NamedModel {
  const name = tier === "cheap" ? config.cheapModel : config.model;
  if (!name) throw new Error("AI_MODEL is not set");
  switch (provider) {
    case "openrouter": {
      if (!config.openrouterApiKey)
        throw new Error("OPENROUTER_API_KEY is not set");
      const openrouter = createOpenRouter({ apiKey: config.openrouterApiKey });
      return {
        name,
        model: openrouter(name, {
          usage: { include: true },
          // Zero data retention, and only providers that honour every parameter (spec §5).
          provider: {
            zdr: true,
            data_collection: "deny",
            require_parameters: true,
          },
        }),
      };
    }
    case "vertex": {
      if (!config.vertexProject) throw new Error("VERTEX_PROJECT is not set");
      const vertex = createVertex({
        project: config.vertexProject,
        location: config.vertexLocation ?? "global",
      });
      return { name, model: vertex(name) };
    }
  }
}
