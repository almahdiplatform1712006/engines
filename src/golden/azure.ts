// Azure AI Document Intelligence, Layout (v4), for the reading trial (E-06):
// paragraphs with roles (pageNumber, sectionHeading, …) and their polygons.
// REST, so the trial needs no Azure SDK. The `formulas` feature is asked for
// (it's part of the price), but the merge doesn't use formulas yet.
import { boxFromPolygon, type Layout, type LayoutSource } from "./layout.ts";

const API_VERSION = "2024-11-30";

export interface AzureOptions {
  endpoint: string;
  key: string;
  /** USD per page, from Azure's price list (Layout + formulas add-on). */
  pricePerPage: number;
  fetch?: typeof fetch;
  /** Between polls of the analysis. */
  pollMs?: number;
}

interface AnalyzeResult {
  pages?: { pageNumber: number; width: number; height: number }[];
  paragraphs?: {
    role?: string;
    content: string;
    boundingRegions?: { pageNumber: number; polygon: number[] }[];
  }[];
}

export function azureLayout(options: AzureOptions): LayoutSource {
  const doFetch = options.fetch ?? fetch;
  const headers = { "ocp-apim-subscription-key": options.key };
  return {
    name: "azure-document-intelligence-layout",
    async analyze(png) {
      const start = await doFetch(
        `${options.endpoint.replace(/\/$/, "")}/documentintelligence/documentModels/prebuilt-layout:analyze?api-version=${API_VERSION}&features=formulas`,
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({
            base64Source: Buffer.from(png).toString("base64"),
          }),
        },
      );
      const operation = start.headers.get("operation-location");
      if (start.status !== 202 || !operation)
        throw new Error(`Azure refused the page (${String(start.status)})`);
      // Up to two minutes, then the page counts as failed.
      for (let tries = 0; tries < 120_000 / (options.pollMs ?? 1000); tries++) {
        const poll = await doFetch(operation, { headers });
        if (!poll.ok)
          throw new Error(
            `Azure analysis poll failed (${String(poll.status)})`,
          );
        const body = (await poll.json()) as {
          status: string;
          analyzeResult?: AnalyzeResult;
        };
        if (body.status === "succeeded")
          return toLayout(body.analyzeResult ?? {}, options.pricePerPage);
        if (body.status === "failed")
          throw new Error("Azure could not analyze the page");
        await new Promise((resolve) =>
          setTimeout(resolve, options.pollMs ?? 1000),
        );
      }
      throw new Error("Azure took over two minutes on the page");
    },
  };
}

export function toLayout(result: AnalyzeResult, pricePerPage: number): Layout {
  const page = result.pages?.[0];
  const regions = (result.paragraphs ?? []).flatMap((p) => {
    const region = p.boundingRegions?.[0];
    if (!page || !region) return [];
    return [
      {
        text: p.content,
        box: boxFromPolygon(region.polygon, page.width, page.height),
        role: p.role ?? null,
      },
    ];
  });
  return {
    pageNumber:
      (result.paragraphs ?? []).find((p) => p.role === "pageNumber")?.content ??
      null,
    regions,
    costUsd: pricePerPage,
  };
}
