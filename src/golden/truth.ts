// The golden-set file formats. `golden/README.md` documents them for people;
// these schemas are what the tools actually check.
import { z } from "zod";

/** A box on the page image, as fractions of its width and height (0–1), so it survives any DPI. */
export const CropBox = z
  .object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    w: z.number().min(0).max(1),
    h: z.number().min(0).max(1),
  })
  .refine((b) => b.x + b.w <= 1.000001 && b.y + b.h <= 1.000001, {
    error: "crop box must stay inside the page",
  });
export type CropBox = z.infer<typeof CropBox>;

export const Stimulus = z.object({
  id: z.string().min(1),
  kind: z.enum(["passage", "diagram", "table"]),
  text: z.string(),
  crop: CropBox.nullable(),
});
export type Stimulus = z.infer<typeof Stimulus>;

export const Question = z.object({
  id: z.string().min(1),
  /** The question's number as printed, used to match the answer key. */
  number: z.string().nullable(),
  type: z.enum(["multiple_choice", "fill_blank", "true_false"]),
  text: z.string(),
  options: z.array(z.object({ key: z.string(), text: z.string() })),
  /** Option keys for multiple_choice and true_false. */
  correct: z.array(z.string()),
  /** Accepted answers for fill_blank. */
  accepted_answers: z.array(z.string()),
  answer_source: z.enum(["book", "marked", "model"]).nullable(),
  stimulus_id: z.string().nullable(),
  math_direction: z.enum(["ltr", "rtl"]).nullable(),
  crop: CropBox.nullable(),
});
export type Question = z.infer<typeof Question>;

export const ExplanationBlock = z.object({
  heading: z.string(),
  markdown: z.string(),
  crop: CropBox.nullable(),
});
export type ExplanationBlock = z.infer<typeof ExplanationBlock>;

/** What one page holds: the shape a page reader returns and a truth file records. */
export const PageContent = z.object({
  pdf_page: z.int().positive(),
  printed_page: z.int().nullable(),
  stimuli: z.array(Stimulus),
  questions: z.array(Question),
  explanation: z.array(ExplanationBlock),
});
export type PageContent = z.infer<typeof PageContent>;

/**
 * `golden/<book>/truth/<page_id>.json`. A draft is the reader's guess and is never
 * scored; the owner sets `status` to `corrected` once the page has been checked.
 */
export const PageTruth = PageContent.extend({
  status: z.enum(["draft", "corrected"]),
});
export type PageTruth = z.infer<typeof PageTruth>;

/** Token usage and cost the reader logged for one page. */
export const Usage = z.object({
  input_tokens: z.int().nonnegative(),
  output_tokens: z.int().nonnegative(),
  cost_usd: z.number().nonnegative(),
});
export type Usage = z.infer<typeof Usage>;

/** `golden/<book>/manifest.json`: which pages are in the set and where their images are. */
export const BookManifest = z.object({
  book: z
    .string()
    .regex(
      /^[a-z0-9][a-z0-9-]*$/,
      "book ids are lowercase letters, digits and dashes",
    ),
  title: z.string(),
  pages: z
    .array(
      z.object({
        id: z
          .string()
          .regex(
            /^[a-z0-9][a-z0-9-]*$/,
            "page ids are lowercase letters, digits and dashes",
          ),
        pdf_page: z.int().positive(),
        /** File name inside `golden/<book>/images/`, which is never committed. */
        image: z
          .string()
          .regex(/^[^/\\]+$/, "image is a file name, not a path"),
      }),
    )
    .min(1),
});
export type BookManifest = z.infer<typeof BookManifest>;
