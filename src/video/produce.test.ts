// A lesson to an MP4 with the scripted voice: failures are recorded, not
// dropped, and an unchanged scene is not rendered twice. The render test
// drives real HyperFrames and Chromium, so it is skipped where there is none.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { chromiumPath } from "../exports/pdf.ts";
import { produceLesson } from "./produce.ts";
import { Lesson } from "./schema.ts";
import { mediaSeconds } from "./render.ts";
import { scriptedVoice, type Voice } from "./tts.ts";

let dir: string;
const chromium = await chromiumPath(process.env["CHROMIUM_PATH"]).catch(
  () => null,
);
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "video-test-"));
});
after(() => rm(dir, { recursive: true, force: true }));

const scene = (id: string) => ({
  id,
  type: "title" as const,
  title: "حل المعادلات",
  narration: "أهلاً بيك يا بطل. النهارده هنتعلم المعادلات.",
});
const lessonOf = (...scenes: unknown[]) =>
  Lesson.parse({ schema_version: 1, title: "درس", scenes });

test("a scene that cannot be voiced or has no figure is recorded and the rest go on", async () => {
  const failing: Voice = {
    speak: () => Promise.reject(new Error("quota")),
  };
  const result = await produceLesson(
    lessonOf(scene("a"), {
      id: "fig",
      type: "figure",
      title: "شكل",
      image: "missing.png",
      narration: "بص على الشكل.",
    }),
    join(dir, "none.mp4"),
    {
      voice: failing,
      render: { chromium: "/nonexistent" },
      lessonDir: dir,
      workDir: join(dir, "work-failures"),
    },
  );
  assert.equal(result.video, null);
  assert.deepEqual(
    result.failures.map((f) => `${f.scene_id}:${f.reason}`),
    ["a:voice_failed", "fig:figure_missing"],
  );
  assert.equal(result.failures[0]?.message, "quota");
});

test(
  "one scene renders to an MP4 with sound, and a second run reuses the clip",
  { skip: chromium === null ? "no Chromium here" : false, timeout: 240_000 },
  async () => {
    assert.ok(chromium);
    const deps = {
      voice: scriptedVoice(),
      render: { chromium, workers: 1 },
      lessonDir: dir,
      workDir: join(dir, "work"),
    };
    const lesson = lessonOf(scene("intro"));
    const first = await produceLesson(lesson, join(dir, "out.mp4"), deps);
    assert.deepEqual(first.failures, []);
    assert.equal(first.clips[0]?.cached, false);
    assert.ok(first.video);
    const length = await mediaSeconds(first.video);
    assert.ok(Math.abs(length - first.seconds) < 0.2);
    assert.ok(length > 2.5 && length < 6, `got ${String(length)} s`);

    const second = await produceLesson(lesson, join(dir, "out2.mp4"), deps);
    assert.equal(second.clips[0]?.cached, true);
  },
);
