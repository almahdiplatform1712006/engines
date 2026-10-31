// `/v1/lessons`: an explainer-video lesson and where it is in review.
import { z } from "zod";
import { Lesson as Script } from "../video/schema.ts";

export const LessonStatus = z.enum([
  "draft",
  "auto_checked",
  "in_review",
  "approved",
  "published",
]);
export type LessonStatus = z.infer<typeof LessonStatus>;

export const CreateLessonRequest = z.object({ script: Script });
export type CreateLessonRequest = z.infer<typeof CreateLessonRequest>;

/** Replacing the script sends the lesson back to `draft`. */
export const ReplaceLessonRequest = CreateLessonRequest;

export const Finding = z.object({
  level: z.enum(["error", "warning"]),
  scene_id: z.string().optional(),
  message: z.string(),
});

export type Finding = z.infer<typeof Finding>;

export const Lesson = z.object({
  id: z.string(),
  object: z.literal("lesson"),
  title: z.string(),
  status: LessonStatus,
  script: Script,
  findings: z.array(Finding),
  /** Set once the video is rendered; a time-limited download URL. */
  video: z.object({ url: z.string(), seconds: z.number() }).nullable(),
  /** Scenes that were attempted and not rendered, with the reason. */
  failures: z.array(
    z.object({ scene_id: z.string(), reason: z.string(), message: z.string() }),
  ),
  created_at: z.string(),
  updated_at: z.string(),
});
export type Lesson = z.infer<typeof Lesson>;
