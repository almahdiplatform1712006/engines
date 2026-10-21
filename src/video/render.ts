// HyperFrames and FFmpeg as separate processes, like poppler: a scene's
// composition folder in, an MP4 out; MP4s in, one MP4 out.
import { execFile, spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface RenderOptions {
  /** The Chromium binary HyperFrames drives. */
  chromium: string;
  fps?: number;
  workers?: number;
}

/** The HyperFrames CLI that npm installed beside this code. */
function hyperframesBin(): string {
  const require = createRequire(import.meta.url);
  return join(
    dirname(require.resolve("hyperframes/package.json")),
    "bin",
    "hyperframes.mjs",
  );
}

function exec(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d: Buffer) => {
      out += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      out += d.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(out);
      else
        reject(
          new Error(`${command} exited ${String(code)}:\n${out.slice(-2000)}`),
        );
    });
  });
}

/** Renders the composition in `dir` (an index.html and what it refers to) to `output`. */
export async function renderScene(
  dir: string,
  output: string,
  options: RenderOptions,
): Promise<void> {
  await exec(
    process.execPath,
    [
      hyperframesBin(),
      "render",
      dir,
      "-o",
      output,
      "--fps",
      String(options.fps ?? 30),
      "--workers",
      String(options.workers ?? 2),
      "--no-browser-gpu",
    ],
    {
      ...process.env,
      HYPERFRAMES_BROWSER_PATH: options.chromium,
      PUPPETEER_EXECUTABLE_PATH: options.chromium,
      HYPERFRAMES_NO_TELEMETRY: "1",
      HYPERFRAMES_NO_UPDATE_CHECK: "1",
      HYPERFRAMES_SKIP_SKILLS: "1",
      DO_NOT_TRACK: "1",
    },
  );
}

/** Scene clips joined into one MP4, stream-copied: every clip has the same encoding. */
export async function concatClips(
  clips: string[],
  listFile: string,
  output: string,
): Promise<void> {
  await writeFile(
    listFile,
    clips.map((c) => `file '${c.replace(/'/g, "'\\''")}'`).join("\n") + "\n",
  );
  await run("ffmpeg", [
    "-y",
    "-loglevel",
    "error",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    listFile,
    "-c",
    "copy",
    "-movflags",
    "+faststart",
    output,
  ]);
}

/** Length of a media file in seconds, from FFmpeg's own probe. */
export async function mediaSeconds(file: string): Promise<number> {
  const { stdout } = await run("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "csv=p=0",
    file,
  ]);
  return Number(stdout.trim());
}
