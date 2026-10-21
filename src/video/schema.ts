// The lesson a video is made from (explainer-video pipeline, style A: narrated
// slides). One scene is one slide with its narration; the schema is the whole
// contract between script writing (hand or model) and rendering.
import { z } from "zod";

export const SCHEMA_VERSION = 1;

/** Where in the teacher's book a scene's content came from. */
const SourceRef = z.object({
  page: z.number().int().positive(),
  note: z.string().optional(),
});

const sceneBase = {
  id: z
    .string()
    .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, "lowercase letters, digits, - and _"),
  /** What the voice reads. Plain Arabic, one thought per sentence. */
  narration: z.string().trim().min(1),
  /** The same text with any pronunciation fixes; the voice reads this when set. */
  narration_tts: z.string().trim().min(1).optional(),
  source_ref: SourceRef.optional(),
};

export const TitleScene = z.object({
  ...sceneBase,
  type: z.literal("title"),
  title: z.string().trim().min(1),
  subtitle: z.string().trim().min(1).optional(),
});

export const BulletsScene = z.object({
  ...sceneBase,
  type: z.literal("bullets"),
  title: z.string().trim().min(1),
  bullets: z.array(z.string().trim().min(1)).min(1).max(8),
});

export const FigureScene = z.object({
  ...sceneBase,
  type: z.literal("figure"),
  title: z.string().trim().min(1),
  /** A file next to the lesson JSON (a crop from the book). */
  image: z.string().min(1),
  /** Revealed one by one while the narration goes on. */
  callouts: z.array(z.string().trim().min(1)).max(6).default([]),
});

export const EquationStepsScene = z.object({
  ...sceneBase,
  type: z.literal("equation_steps"),
  title: z.string().trim().min(1),
  /** LaTeX, one line per step. Arabic letters (س، ص) are written as they are. */
  steps: z
    .array(
      z.object({
        latex: z.string().trim().min(1),
        note: z.string().trim().min(1).optional(),
      }),
    )
    .min(1)
    .max(8),
  /** Equations flow right to left, as the Egyptian books print them. */
  rtl: z.boolean().default(true),
});

export const Scene = z.discriminatedUnion("type", [
  TitleScene,
  BulletsScene,
  FigureScene,
  EquationStepsScene,
]);
export type Scene = z.infer<typeof Scene>;

export const Lesson = z
  .object({
    schema_version: z.literal(SCHEMA_VERSION),
    title: z.string().trim().min(1),
    /** The voice's name in the TTS provider; the configured default when unset. */
    voice: z.string().min(1).optional(),
    scenes: z.array(Scene).min(1).max(40),
  })
  .superRefine((lesson, ctx) => {
    const seen = new Set<string>();
    lesson.scenes.forEach((scene, i) => {
      if (seen.has(scene.id))
        ctx.addIssue({
          code: "custom",
          path: ["scenes", i, "id"],
          message: `Scene id "${scene.id}" is used twice.`,
        });
      seen.add(scene.id);
    });
  });
export type Lesson = z.infer<typeof Lesson>;
