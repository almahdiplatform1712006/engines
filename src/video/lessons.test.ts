// A lesson's review states over `/v1/lessons`, and one organisation never sees another's.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { startHarness, type Harness } from "../../test/harness.ts";
import { scriptedReader } from "../reading/scripted.ts";
import { systemClock } from "../shared/clock.ts";
import { attachVideo } from "./lessons.ts";

let h: Harness;
before(async () => {
  h = await startHarness({ reader: () => scriptedReader({ pages: {} }) });
});
after(() => h.close());

const script = (narration = "أهلاً بيك يا بطل.") => ({
  schema_version: 1,
  title: "درس",
  scenes: [{ id: "intro", type: "title", title: "عنوان", narration }],
});

interface Lesson {
  id: string;
  status: string;
  findings: { level: string; scene_id?: string }[];
  video: { url: string; seconds: number } | null;
  error?: { code: string };
}
async function api(method: string, path: string, body?: unknown, key?: string) {
  const response = await h.call(method, path, body, key);
  return { status: response.status, body: (await response.json()) as Lesson };
}

/** A lesson that has passed its checks and has a video, ready for review. */
async function checkedWithVideo(): Promise<string> {
  const { body } = await api("POST", "/v1/lessons", { script: script() });
  await api("POST", `/v1/lessons/${body.id}/check`);
  await attachVideo(h.db, h.store, systemClock, h.orgId, body.id, {
    bytes: Buffer.from("mp4"),
    seconds: 4.2,
    failures: [],
  });
  return body.id;
}

test("draft → auto_checked → in_review → approved → published, no step skipped", async () => {
  const created = await api("POST", "/v1/lessons", { script: script() });
  assert.equal(created.status, 201);
  assert.equal(created.body.status, "draft");
  assert.equal(created.body.video, null);
  assert.match(created.body.id, /^les_/);
  const id = created.body.id;
  const step = (name: string) => api("POST", `/v1/lessons/${id}/${name}`);

  assert.equal((await step("submit")).status, 409);
  assert.equal((await step("approve")).status, 409);
  assert.equal((await step("publish")).status, 409);

  assert.equal((await step("check")).body.status, "auto_checked");
  // Review needs a video to watch.
  assert.equal((await step("submit")).status, 409);

  await attachVideo(h.db, h.store, systemClock, h.orgId, id, {
    bytes: Buffer.from("mp4"),
    seconds: 4.2,
    failures: [],
  });
  const withVideo = await api("GET", `/v1/lessons/${id}`);
  assert.ok(withVideo.body.video);
  assert.equal(withVideo.body.video.seconds, 4.2);
  assert.match(withVideo.body.video.url, /\/local-storage\/files\?/);

  assert.equal((await step("submit")).body.status, "in_review");
  assert.equal((await step("reject")).body.status, "draft");
  await step("check");
  assert.equal((await step("submit")).body.status, "in_review");
  assert.equal((await step("approve")).body.status, "approved");
  assert.equal((await step("publish")).body.status, "published");
  assert.equal((await step("publish")).status, 409);
});

test("a script the checks reject stays a draft, with its findings", async () => {
  const { body } = await api("POST", "/v1/lessons", {
    script: script("الناتج $x^2$ هو"),
  });
  const checked = await api("POST", `/v1/lessons/${body.id}/check`);
  assert.equal(checked.body.status, "draft");
  assert.deepEqual(
    checked.body.findings.map((f) => `${f.level}:${f.scene_id ?? ""}`),
    ["error:intro"],
  );
});

test("a changed script goes back to draft and loses its video; a frozen lesson cannot change", async () => {
  const id = await checkedWithVideo();
  const replaced = await api("PUT", `/v1/lessons/${id}`, {
    script: script("نص جديد."),
  });
  assert.equal(replaced.status, 200);
  assert.equal(replaced.body.status, "draft");
  assert.equal(replaced.body.video, null);
  assert.deepEqual(replaced.body.findings, []);

  const frozen = await checkedWithVideo();
  await api("POST", `/v1/lessons/${frozen}/submit`);
  await api("POST", `/v1/lessons/${frozen}/approve`);
  const refused = await api("PUT", `/v1/lessons/${frozen}`, {
    script: script(),
  });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error?.code, "wrong_state");
});

test("an invalid script is refused, and another organisation cannot see the lesson", async () => {
  const bad = await api("POST", "/v1/lessons", {
    script: { ...script(), scenes: [] },
  });
  assert.equal(bad.status, 400);

  const { body } = await api("POST", "/v1/lessons", { script: script() });
  const other = await h.newKey("Another school");
  assert.equal(
    (await api("GET", `/v1/lessons/${body.id}`, undefined, other.key)).status,
    404,
  );
  assert.equal(
    (await api("POST", `/v1/lessons/${body.id}/check`, undefined, other.key))
      .status,
    404,
  );
});
