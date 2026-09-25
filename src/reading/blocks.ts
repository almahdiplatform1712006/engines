// What the model returns for a page (spec #1 §4 step 2), and the normalised
// blocks the rest of Engines works with.
//
// The model-facing schema is flat: every block carries every field, most of them
// nullable, because providers' JSON-schema modes handle flat objects far better
// than unions (ADR 0001). `toBlocks` turns that into normalised blocks, fixing or
// flagging bad combinations instead of throwing.
import { z } from "zod";
import type { CropBox } from "../contract/crop.ts";
import { MathDirection, QuestionType } from "../contract/document.ts";
import { parsePrintedNumber } from "../shared/text.ts";

export const BLOCK_KINDS = [
  "heading",
  "question",
  "explanation",
  "passage",
  "answer_key",
  "neither",
] as const;
export const BlockKind = z.enum(BLOCK_KINDS);
export type BlockKind = z.infer<typeof BlockKind>;

export { MathDirection, QuestionType };

const Option = z.object({
  key: z
    .string()
    .describe("The option's label exactly as printed, e.g. أ or a"),
  text: z.string().describe("The option text, math as LaTeX"),
});

const AnswerEntry = z.object({
  section: z
    .string()
    .nullable()
    .describe(
      "The lesson or section heading the answer belongs to, as printed",
    ),
  number: z.string().describe("The question number as printed"),
  answer: z.string().describe("The answer as printed: an option label or text"),
});

export const ModelBlock = z.object({
  kind: BlockKind.describe(
    "heading: a title; question: an exercise to answer; explanation: teaching text; passage: a shared passage, diagram or table that questions refer to; answer_key: an answers list; neither: anything else (page furniture, pictures with no use)",
  ),
  text: z
    .string()
    .describe(
      "The block's text in reading order, copied exactly. Markdown; math as LaTeX in $…$ or $$…$$, never translated. For a question, the stem only",
    ),
  box_2d: z
    .array(z.int().min(0).max(1000))
    .nullable()
    .describe("[ymin, xmin, ymax, xmax] of the block on the image, 0–1000"),
  continues: z
    .boolean()
    .describe(
      "True only for the last block when it runs off the bottom of the page",
    ),
  continued_from: z
    .boolean()
    .describe(
      "True only for the first block when it clearly continues from the previous page",
    ),
  confidence: z.number().min(0).max(1),
  math_direction: MathDirection.nullable().describe(
    "Direction the block's math is written in, when it has math",
  ),
  question_number: z.string().nullable(),
  question_type: QuestionType.nullable(),
  options: z
    .array(Option)
    .describe("Options of a multiple-choice or true/false question"),
  marked: z
    .array(z.string())
    .describe(
      "Option labels (or written answers) visibly marked by hand: a circle, tick or fill",
    ),
  needs_figure: z
    .boolean()
    .describe(
      "True when the question cannot be answered without a figure or table",
    ),
  stimulus_label: z
    .string()
    .nullable()
    .describe(
      "For a question that depends on a passage, figure or table: its label or the instruction, e.g. 'Figure 3' or 'اقرأ النص ثم أجب'",
    ),
  stimulus_kind: z.enum(["passage", "diagram", "table"]).nullable(),
  label: z
    .string()
    .nullable()
    .describe("For a passage block: its printed label, e.g. 'Figure 3'"),
  covers: z
    .object({ from: z.string(), to: z.string() })
    .nullable()
    .describe(
      "For a passage block: the question numbers it says it covers, e.g. 'answer questions 12–19'",
    ),
  answers: z
    .array(AnswerEntry)
    .describe("For an answer_key block: its entries"),
});
export type ModelBlock = z.infer<typeof ModelBlock>;

export const ModelPage = z.object({
  printed_page: z
    .string()
    .nullable()
    .describe(
      "The page number printed on the page, exactly as printed, or null",
    ),
  blocks: z
    .array(ModelBlock)
    .describe("Every block on the page, in reading order"),
});
export type ModelPage = z.infer<typeof ModelPage>;

/** A normalised block. `id` is `p<pdf page>#<index>`, stable for the document's life. */
export interface Block {
  id: string;
  pdf_page: number;
  /** Position in the page's reading order. */
  order: number;
  kind: BlockKind;
  text: string;
  box: CropBox | null;
  continues: boolean;
  continued_from: boolean;
  confidence: number;
  math_direction: MathDirection | null;
  question: {
    number: string | null;
    type: QuestionType;
    options: { key: string; text: string }[];
    marked: string[];
    needs_figure: boolean;
    stimulus_label: string | null;
  } | null;
  stimulus: {
    kind: "passage" | "diagram" | "table";
    label: string | null;
    covers: { from: string; to: string } | null;
  } | null;
  answers: { section: string | null; number: string; answer: string }[];
  /** Why this block was changed while normalising it, if it was. */
  repaired: string | null;
}

/** One page as read: its printed number (raw and parsed) and normalised blocks. */
export interface PageReading {
  pdf_page: number;
  printed_raw: string | null;
  printed_number: number | null;
  blocks: Block[];
}

export function toPageReading(pdfPage: number, page: ModelPage): PageReading {
  return {
    pdf_page: pdfPage,
    printed_raw: page.printed_page,
    printed_number: parsePrintedNumber(page.printed_page),
    blocks: page.blocks.map((block, order) => toBlock(pdfPage, order, block)),
  };
}

export function toBlock(
  pdfPage: number,
  order: number,
  raw: ModelBlock,
): Block {
  const repairs: string[] = [];
  const isQuestion = raw.kind === "question";
  let type = raw.question_type;
  if (isQuestion && type === null) {
    type = raw.options.length >= 2 ? "multiple_choice" : "fill_blank";
    repairs.push(`question_type missing, taken as ${type}`);
  }
  return {
    id: `p${String(pdfPage)}#${String(order)}`,
    pdf_page: pdfPage,
    order,
    kind: raw.kind,
    text: raw.text.trim(),
    box: toCropBox(raw.box_2d),
    continues: raw.continues,
    continued_from: raw.continued_from,
    confidence: raw.confidence,
    math_direction: raw.math_direction,
    question:
      isQuestion && type !== null
        ? {
            number: emptyToNull(raw.question_number?.trim()),
            type,
            options: raw.options.map((o) => ({
              key: o.key.trim(),
              text: o.text.trim(),
            })),
            marked: raw.marked,
            needs_figure: raw.needs_figure,
            stimulus_label: raw.stimulus_label,
          }
        : null,
    stimulus:
      raw.kind === "passage"
        ? {
            kind: raw.stimulus_kind ?? "passage",
            label: raw.label,
            covers: raw.covers,
          }
        : null,
    answers: raw.kind === "answer_key" ? raw.answers : [],
    repaired: repairs.length ? repairs.join("; ") : null,
  };
}

/** Gemini-style `[ymin, xmin, ymax, xmax]` on 0–1000 → a 0–1 crop box, or null when unusable. */
export function toCropBox(box: readonly number[] | null): CropBox | null {
  if (box?.length !== 4) return null;
  const [ymin = 0, xmin = 0, ymax = 0, xmax = 0] = box.map((v) =>
    Math.min(1000, Math.max(0, v)),
  );
  if (ymax <= ymin || xmax <= xmin) return null;
  return {
    x: xmin / 1000,
    y: ymin / 1000,
    w: (xmax - xmin) / 1000,
    h: (ymax - ymin) / 1000,
  };
}

function emptyToNull(text: string | undefined): string | null {
  return text === undefined || text === "" ? null : text;
}
