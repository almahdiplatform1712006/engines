// A lesson to an MP4, scene by scene. Each scene is voiced, timed, composed and
// rendered on its own, and a finished clip is kept by content hash, so fixing
// one scene re-renders one clip. A scene that fails is recorded with its
// reason and the lesson goes on without it (nothing dropped silently).
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, extname, join, resolve } from "node:path";
import type { Lesson, Scene } from "./schema.ts";
import {
  concatClips,
  mediaSeconds,
  renderScene,
  type RenderOptions,
} from "./render.ts";
import { sentenceAligner, revealTimes, type Aligner } from "./timing.ts";
import {
  FONT_FILES,
  revealCount,
  scenePage,
  TEMPLATE_VERSION,
} from "./templates.ts";
import type { Voice } from "./tts.ts";
import { wavSeconds } from "./wav.ts";

/** Quiet after the last word, so a scene does not cut off the voice. */
const REST_SECONDS = 0.6;

export interface SceneFailure {
  scene_id: string;
  reason: "voice_failed" | "render_failed" | "figure_missing";
  message: string;
}

export interface SceneClip {
  scene_id: string;
  file: string;
  seconds: number;
  cached: boolean;
}

export interface ProduceDeps {
  voice: Voice;
  aligner?: Aligner;
  render: RenderOptions;
  /** Where the lesson's files (figure crops) are read from. */
  lessonDir: string;
  /** Working and cache folder. */
  workDir: string;
}

export interface Produced {
  /** The finished MP4, or null when no scene could be rendered. */
  video: string | null;
  seconds: number;
  clips: SceneClip[];
  failures: SceneFailure[];
}

const FONT_DIR = (() => {
  const require = createRequire(import.meta.url);
  return join(
    dirname(require.resolve("@fontsource/noto-sans-arabic/package.json")),
    "files",
  );
})();

function sceneKey(scene: Scene, voice: string, figure: Buffer | null): string {
  return createHash("sha256")
    .update(JSON.stringify([TEMPLATE_VERSION, voice, scene]))
    .update(figure ?? "")
    .digest("hex")
    .slice(0, 24);
}

export async function produceLesson(
  lesson: Lesson,
  output: string,
  deps: ProduceDeps,
): Promise<Produced> {
  const aligner = deps.aligner ?? sentenceAligner;
  const clips: SceneClip[] = [];
  const failures: SceneFailure[] = [];
  const clipDir = join(deps.workDir, "clips");
  await mkdir(clipDir, { recursive: true });

  for (const scene of lesson.scenes) {
    let figure: Buffer | null = null;
    if (scene.type === "figure") {
      try {
        figure = await readFile(resolve(deps.lessonDir, scene.image));
      } catch {
        failures.push({
          scene_id: scene.id,
          reason: "figure_missing",
          message: `Cannot read ${scene.image}.`,
        });
        continue;
      }
    }
    const key = sceneKey(scene, lesson.voice ?? "", figure);
    const clip = join(clipDir, `${scene.id}-${key}.mp4`);
    try {
      await stat(clip);
      clips.push({
        scene_id: scene.id,
        file: clip,
        seconds: await mediaSeconds(clip),
        cached: true,
      });
      continue;
    } catch {
      // not rendered yet
    }

    const dir = join(deps.workDir, "scenes", scene.id);
    await rm(dir, { recursive: true, force: true });
    await mkdir(join(dir, "fonts"), { recursive: true });

    let wav: Buffer;
    try {
      ({ wav } = await deps.voice.speak({
        text: scene.narration_tts ?? scene.narration,
        voice: lesson.voice,
      }));
    } catch (error) {
      failures.push({
        scene_id: scene.id,
        reason: "voice_failed",
        message: messageOf(error),
      });
      continue;
    }

    try {
      const audioSeconds = wavSeconds(wav);
      const spans = await aligner.align({
        text: scene.narration,
        audioSeconds,
      });
      const reveals = revealTimes(revealCount(scene), spans, audioSeconds);
      const figureFile = figure
        ? `figure${extname(scene.type === "figure" ? scene.image : "") || ".png"}`
        : undefined;
      await writeFile(join(dir, "narration.wav"), wav);
      if (figure && figureFile) await writeFile(join(dir, figureFile), figure);
      for (const f of FONT_FILES)
        await copyFile(
          join(FONT_DIR, `noto-sans-arabic-${f}.woff2`),
          join(dir, "fonts", `${f}.woff2`),
        );
      await writeFile(
        join(dir, "index.html"),
        scenePage(scene, {
          duration: audioSeconds + REST_SECONDS,
          reveals,
          audio: "narration.wav",
          ...(figureFile ? { figureFile } : {}),
        }),
      );
      const tmp = `${clip}.part.mp4`;
      await renderScene(dir, tmp, deps.render);
      await rename(tmp, clip);
      clips.push({
        scene_id: scene.id,
        file: clip,
        seconds: await mediaSeconds(clip),
        cached: false,
      });
    } catch (error) {
      failures.push({
        scene_id: scene.id,
        reason: "render_failed",
        message: messageOf(error),
      });
    }
  }

  if (clips.length === 0) return { video: null, seconds: 0, clips, failures };
  await mkdir(dirname(resolve(output)), { recursive: true });
  await concatClips(
    clips.map((c) => resolve(c.file)),
    join(deps.workDir, "clips.txt"),
    resolve(output),
  );
  return {
    video: resolve(output),
    seconds: clips.reduce((sum, c) => sum + c.seconds, 0),
    clips,
    failures,
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
