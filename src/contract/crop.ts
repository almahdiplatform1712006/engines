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
