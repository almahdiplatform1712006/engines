// The golden tools' view of Engines' own page reader: the same PageReader the
// pipeline runs, its blocks turned into the golden truth shape so the scorers
// can compare them (E-03, E-06, E-07).
import { readFile } from "node:fs/promises";
import type { Block, PageReading as EngineReading } from "../reading/blocks.ts";
import type {
  ModelCall,
  PageReader as EngineReader,
  RecordCall,
} from "../reading/reader.ts";
import type { PageReader } from "./reader.ts";
import type { PageContent } from "./truth.ts";

/**
 * Wraps an Engines reader built around `record`, so each golden read reports
 * the tokens and cost its call logged.
 */
export function goldenReader(
  name: string,
  build: (record: RecordCall) => EngineReader,
): PageReader {
  let calls: ModelCall[] = [];
  const reader = build((call) => {
    calls.push(call);
    return Promise.resolve();
  });
  return {
    name,
    async read(image) {
      calls = [];
      const reading = await reader.readPage(
        {
          pdfPage: image.pdf_page,
          bytes: await readFile(image.path),
          mediaType: "image/png",
        },
        { orgId: "golden", documentId: null },
      );
      return {
        content: toPageContent(reading),
        usage: {
          input_tokens: sum(calls, (c) => c.inputTokens),
          output_tokens: sum(calls, (c) => c.outputTokens),
          cost_usd: sum(calls, (c) => c.costUsd),
        },
      };
    },
  };
}

/** Blocks → the truth shape: questions, stimuli and heading-led explanation. */
export function toPageContent(reading: EngineReading): PageContent {
  const content: PageContent = {
    pdf_page: reading.pdf_page,
    printed_page: reading.printed_number,
    stimuli: [],
    questions: [],
    explanation: [],
  };
  let heading = "";
  let stimulusId: string | null = null;
  for (const block of reading.blocks) {
    if (block.kind === "heading") heading = block.text;
    if (block.kind === "passage" && block.stimulus) {
      stimulusId = `s${String(content.stimuli.length + 1)}`;
      content.stimuli.push({
        id: stimulusId,
        kind: block.stimulus.kind,
        text: block.text,
        crop: block.box,
      });
    }
    if (block.kind === "explanation") {
      content.explanation.push({
        heading,
        markdown: block.text,
        crop: block.box,
      });
    }
    if (block.kind === "question" && block.question)
      content.questions.push(toQuestion(block, content, stimulusId));
  }
  return content;
}

function toQuestion(
  block: Block,
  content: PageContent,
  stimulusId: string | null,
): PageContent["questions"][number] {
  const q = block.question;
  if (!q) throw new Error("not a question");
  const marked = q.marked.filter((key) => q.options.some((o) => o.key === key));
  return {
    id: `q${String(content.questions.length + 1)}`,
    number: q.number,
    type: q.type,
    text: block.text,
    options: q.options,
    correct: marked,
    accepted_answers: q.type === "fill_blank" ? q.marked : [],
    answer_source:
      marked.length > 0 || (q.type === "fill_blank" && q.marked.length > 0)
        ? "marked"
        : null,
    stimulus_id: q.stimulus_label === null ? null : stimulusId,
    math_direction: block.math_direction,
    crop: block.box,
  };
}

function sum<T>(items: readonly T[], of: (item: T) => number): number {
  return items.reduce((total, item) => total + of(item), 0);
}
