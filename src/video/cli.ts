// npm run video -- <lesson.json> [--out lesson.mp4] [--work .data/video] [--dry]
// npm run video -- --lesson <lesson_id> --org <org_id> [--dry]
// Renders a lesson to an MP4. `--dry` voices it with silence (no model call).
// npm run video -- --models        lists OpenRouter's voice (audio-output) models, to set TTS_MODEL
// With `--lesson` the script comes from the database and the MP4 is attached
// to the lesson, which must have passed its checks.
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { chromiumPath } from "../exports/pdf.ts";
import { systemClock } from "../shared/clock.ts";
import {
  readDatabaseConfig,
  readStorageConfig,
  readVideoConfig,
  type VideoConfig,
} from "../shared/config.ts";
import { connect, type Db } from "../shared/db/pool.ts";
import { storeFromConfig } from "../storage/from-config.ts";
import type { BlobStore } from "../storage/store.ts";
import { attachVideo } from "./lessons.ts";
import { checkLesson } from "./checks.ts";
import { produceLesson } from "./produce.ts";
import { Lesson } from "./schema.ts";
import { openRouterVoice, scriptedVoice, type Voice } from "./tts.ts";

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      out: { type: "string" },
      work: { type: "string", default: ".data/video" },
      dry: { type: "boolean", default: false },
      lesson: { type: "string" },
      models: { type: "boolean", default: false },
      org: { type: "string" },
    },
  });
  if (values.models) return listVoiceModels();
  const [file] = positionals;
  const stored = values.lesson !== undefined;
  if (stored ? values.org === undefined : !file) {
    console.error(
      "usage: npm run video -- <lesson.json> [--out lesson.mp4] [--dry]\n       npm run video -- --lesson <lesson_id> --org <org_id> [--dry]",
    );
    return 2;
  }
  const config = readVideoConfig(process.env);
  const db = stored
    ? connect(readDatabaseConfig(process.env).databaseUrl, 2)
    : null;
  const store = stored ? storeFromConfig(readStorageConfig(process.env)) : null;
  try {
    return await render(
      values,
      file,
      config,
      db && store
        ? { db, store, lessonId: values.lesson ?? "", orgId: values.org ?? "" }
        : null,
    );
  } finally {
    await db?.close();
  }
}

interface Stored {
  db: Db;
  store: BlobStore;
  lessonId: string;
  orgId: string;
}

async function render(
  values: { out?: string | undefined; work: string; dry: boolean },
  file: string | undefined,
  config: VideoConfig,
  stored: Stored | null,
): Promise<number> {
  let source: unknown;
  if (stored) {
    const { rows } = await stored.db.query<{ script: unknown }>(
      "SELECT script FROM lessons WHERE id = $1 AND org_id = $2",
      [stored.lessonId, stored.orgId],
    );
    if (!rows[0]) {
      console.error(`No lesson ${stored.lessonId}.`);
      return 1;
    }
    source = rows[0].script;
  } else {
    source = JSON.parse(await readFile(file ?? "", "utf8"));
  }
  const parsed = Lesson.safeParse(source);
  if (!parsed.success) {
    console.error(parsed.error.message);
    return 1;
  }
  const lesson = parsed.data;
  const findings = checkLesson(lesson);
  for (const f of findings)
    console.error(`${f.level}: ${f.scene_id ?? "lesson"}: ${f.message}`);
  if (findings.some((f) => f.level === "error")) return 1;

  let voice: Voice;
  if (values.dry) {
    voice = scriptedVoice();
  } else {
    if (!config.openrouterApiKey || !config.ttsModel)
      throw new Error(
        "Set OPENROUTER_API_KEY and TTS_MODEL, or run with --dry.",
      );
    voice = openRouterVoice({
      apiKey: config.openrouterApiKey,
      model: config.ttsModel,
      voice: config.ttsVoice,
      style: config.ttsStyle,
    });
  }
  const work = resolve(values.work);
  await mkdir(work, { recursive: true });
  const out = resolve(values.out ?? join(work, "lesson.mp4"));
  const result = await produceLesson(lesson, out, {
    voice,
    render: { chromium: await chromiumPath(config.chromiumPath) },
    lessonDir: file ? dirname(resolve(file)) : work,
    workDir: work,
  });
  for (const f of result.failures)
    console.error(`failed: ${f.scene_id}: ${f.reason}: ${f.message}`);
  console.log(
    result.video
      ? `${result.video} (${result.seconds.toFixed(1)}s, ${String(result.clips.length)} of ${String(lesson.scenes.length)} scenes)`
      : "No scene could be rendered.",
  );
  if (stored && result.video) {
    await attachVideo(
      stored.db,
      stored.store,
      systemClock,
      stored.orgId,
      stored.lessonId,
      {
        bytes: await readFile(result.video),
        seconds: result.seconds,
        failures: result.failures,
      },
    );
    console.log(`attached to ${stored.lessonId}`);
  }
  return result.failures.length > 0 ? 1 : 0;
}

/** OpenRouter's models that can answer with audio: the candidates for TTS_MODEL. */
async function listVoiceModels(): Promise<number> {
  const response = await fetch(
    "https://openrouter.ai/api/v1/models?output_modalities=audio",
  );
  if (!response.ok) {
    console.error(`OpenRouter answered ${String(response.status)}.`);
    return 1;
  }
  const { data } = (await response.json()) as { data: { id: string }[] };
  for (const model of data) console.log(model.id);
  return 0;
}

process.exitCode = await main(process.argv.slice(2));
