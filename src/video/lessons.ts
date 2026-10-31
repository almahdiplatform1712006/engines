// Lessons in Postgres and their review states:
//   draft → auto_checked → in_review → approved → published
// `check` moves a draft forward when the automatic checks find no error;
// `submit` needs a rendered video so the reviewer has something to watch;
// `reject` and any script change send a lesson back to draft. A lesson that is
// approved or published is frozen: its script changes only through a new lesson.
import type {
  Finding,
  Lesson as LessonView,
  LessonStatus,
} from "../contract/lesson.ts";
import type { Clock } from "../shared/clock.ts";
import type { Queryable } from "../shared/db/pool.ts";
import { newId } from "../shared/ids.ts";
import { Refusal } from "../shared/refusal.ts";
import type { BlobStore } from "../storage/store.ts";
import { checkLesson } from "./checks.ts";
import { Lesson as Script } from "./schema.ts";
import type { SceneFailure } from "./produce.ts";

export const VIDEO_URL_TTL_SECONDS = 3600;

interface Row {
  id: string;
  org_id: string;
  title: string;
  status: LessonStatus;
  script: unknown;
  findings: Finding[];
  video_key: string | null;
  video_seconds: number | null;
  failures: SceneFailure[];
  created_at: Date;
  updated_at: Date;
}

/** Where a lesson may go next, and from where. */
const NEXT: Record<
  "submit" | "approve" | "publish",
  { from: LessonStatus; to: LessonStatus }
> = {
  submit: { from: "auto_checked", to: "in_review" },
  approve: { from: "in_review", to: "approved" },
  publish: { from: "approved", to: "published" },
};

async function row(
  db: Queryable,
  orgId: string,
  id: string,
  lock = false,
): Promise<Row> {
  const { rows } = await db.query<Row>(
    `SELECT * FROM lessons WHERE id = $1 AND org_id = $2${lock ? " FOR UPDATE" : ""}`,
    [id, orgId],
  );
  const found = rows[0];
  if (!found) throw new Refusal("not_found", `No lesson ${id}.`);
  return found;
}

export async function createLesson(
  db: Queryable,
  clock: Clock,
  orgId: string,
  script: Script,
): Promise<string> {
  const id = newId("les");
  await db.query(
    `INSERT INTO lessons (id, org_id, title, script, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $5)`,
    [id, orgId, script.title, JSON.stringify(script), clock()],
  );
  return id;
}

export async function replaceScript(
  db: Queryable,
  clock: Clock,
  orgId: string,
  id: string,
  script: Script,
): Promise<void> {
  const current = await row(db, orgId, id, true);
  if (current.status === "approved" || current.status === "published")
    throw new Refusal(
      "wrong_state",
      `A ${current.status} lesson can't be changed.`,
    );
  // A new script means a new video: the old one and its checks no longer describe it.
  await db.query(
    `UPDATE lessons SET title = $3, script = $4, status = 'draft', findings = '[]',
       video_key = NULL, video_seconds = NULL, failures = '[]', updated_at = $5
     WHERE id = $1 AND org_id = $2`,
    [id, orgId, script.title, JSON.stringify(script), clock()],
  );
}

/** Runs the automatic checks: no error moves a draft to `auto_checked`. */
export async function checkStep(
  db: Queryable,
  clock: Clock,
  orgId: string,
  id: string,
): Promise<void> {
  const current = await row(db, orgId, id, true);
  if (current.status !== "draft" && current.status !== "auto_checked")
    throw new Refusal(
      "wrong_state",
      `A ${current.status} lesson is past the checks.`,
    );
  const findings = checkLesson(Script.parse(current.script));
  const status = findings.some((f) => f.level === "error")
    ? "draft"
    : "auto_checked";
  await db.query(
    "UPDATE lessons SET findings = $3, status = $4, updated_at = $5 WHERE id = $1 AND org_id = $2",
    [id, orgId, JSON.stringify(findings), status, clock()],
  );
}

/** The reviewer's side: submit, approve, publish. */
export async function advance(
  db: Queryable,
  clock: Clock,
  orgId: string,
  id: string,
  step: keyof typeof NEXT,
): Promise<void> {
  const current = await row(db, orgId, id, true);
  const { from, to } = NEXT[step];
  if (current.status !== from)
    throw new Refusal(
      "wrong_state",
      `Only a lesson that is ${from} can be moved to ${to}; this one is ${current.status}.`,
    );
  if (current.video_key === null)
    throw new Refusal("wrong_state", "Render the video first.");
  await db.query(
    "UPDATE lessons SET status = $3, updated_at = $4 WHERE id = $1 AND org_id = $2",
    [id, orgId, to, clock()],
  );
}

export async function reject(
  db: Queryable,
  clock: Clock,
  orgId: string,
  id: string,
): Promise<void> {
  const current = await row(db, orgId, id, true);
  if (current.status !== "in_review")
    throw new Refusal(
      "wrong_state",
      `Only a lesson in review can be rejected; this one is ${current.status}.`,
    );
  await db.query(
    "UPDATE lessons SET status = 'draft', updated_at = $3 WHERE id = $1 AND org_id = $2",
    [id, orgId, clock()],
  );
}

/** Records the rendered video (the renderer's side): the lesson must have passed the checks. */
export async function attachVideo(
  db: Queryable,
  store: BlobStore,
  clock: Clock,
  orgId: string,
  id: string,
  video: { bytes: Uint8Array; seconds: number; failures: SceneFailure[] },
): Promise<void> {
  const current = await row(db, orgId, id);
  if (current.status !== "auto_checked")
    throw new Refusal(
      "wrong_state",
      `Check the lesson before rendering; this one is ${current.status}.`,
    );
  const key = `results/lessons/${orgId}/${id}/${String(clock().getTime())}.mp4`;
  await store.put(key, video.bytes, "video/mp4");
  await db.query(
    `UPDATE lessons SET video_key = $3, video_seconds = $4, failures = $5, updated_at = $6
     WHERE id = $1 AND org_id = $2`,
    [id, orgId, key, video.seconds, JSON.stringify(video.failures), clock()],
  );
  if (current.video_key) await store.delete(current.video_key);
}

export async function getLesson(
  db: Queryable,
  store: BlobStore,
  orgId: string,
  id: string,
): Promise<LessonView> {
  const r = await row(db, orgId, id);
  return {
    id: r.id,
    object: "lesson",
    title: r.title,
    status: r.status,
    script: Script.parse(r.script),
    findings: r.findings,
    video:
      r.video_key === null
        ? null
        : {
            url: await store.signedUrl(r.video_key, VIDEO_URL_TTL_SECONDS),
            seconds: r.video_seconds ?? 0,
          },
    failures: r.failures,
    created_at: r.created_at.toISOString(),
    updated_at: r.updated_at.toISOString(),
  };
}
