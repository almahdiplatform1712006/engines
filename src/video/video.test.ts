// The pure parts of the explainer-video pipeline: schema, timing, checks,
// templates, the WAV helper and the voice adapters.
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkLesson } from "./checks.ts";
import { Lesson } from "./schema.ts";
import { alignBySentence, revealTimes, splitSentences } from "./timing.ts";
import { revealCount, scenePage } from "./templates.ts";
import { openRouterVoice, scriptedVoice } from "./tts.ts";
import { encodeWav, silence, wavSeconds } from "./wav.ts";

const lesson = (scenes: unknown[]) => ({
  schema_version: 1,
  title: "درس",
  scenes,
});
const title = (id: string, narration = "أهلاً بيك يا بطل.") => ({
  id,
  type: "title",
  title: "عنوان",
  narration,
});

test("a lesson needs unique scene ids and a known scene type", () => {
  assert.ok(Lesson.safeParse(lesson([title("a"), title("b")])).success);
  const twice = Lesson.safeParse(lesson([title("a"), title("a")]));
  assert.ok(!twice.success);
  assert.match(twice.error.message, /used twice/);
  assert.ok(
    !Lesson.safeParse(lesson([{ ...title("a"), type: "video" }])).success,
  );
  assert.ok(!Lesson.safeParse(lesson([{ ...title("A b") }])).success);
});

test("sentences split on Arabic and Latin marks", () => {
  assert.deepEqual(splitSentences("أولاً نفهم. وبعدين نحل؟ تمام!"), [
    "أولاً نفهم.",
    "وبعدين نحل؟",
    "تمام!",
  ]);
  assert.deepEqual(splitSentences("..."), []);
});

test("sentence times share the audio by length and cover all of it", () => {
  const spans = alignBySentence(
    "جملة قصيرة. وهذه جملة أطول بكثير من الأولى.",
    10,
  );
  const [first, second] = spans;
  assert.ok(first && second && spans.length === 2);
  assert.equal(first.start, 0);
  assert.equal(first.end, second.start);
  assert.equal(second.end, 10);
  assert.ok(first.end < 5, "the shorter sentence takes less time");
});

test("reveals follow the sentences when there are enough, else spread out", () => {
  const spans = alignBySentence("واحد. اثنين. ثلاثة. أربعة.", 8);
  const four = revealTimes(2, spans, 8);
  assert.equal(
    four[1],
    spans[2]?.start,
    "2 items over 4 sentences: sentences 1 and 3",
  );
  const even = revealTimes(4, alignBySentence("جملة واحدة.", 8), 8);
  assert.deepEqual(even, [0.3, 2, 4, 6]);
  assert.deepEqual(revealTimes(0, spans, 8), []);
});

test("a WAV's length is measured from its own header", () => {
  assert.ok(Math.abs(wavSeconds(silence(2.5)) - 2.5) < 0.001);
  assert.throws(() => wavSeconds(Buffer.from("nope")), /Not a WAV/);
  const pcm = Buffer.alloc(48000 * 2);
  assert.equal(wavSeconds(encodeWav({ sampleRate: 48000, samples: pcm })), 1);
});

test("the scripted voice is as long as the text takes to say", async () => {
  const voice = scriptedVoice();
  const short = wavSeconds((await voice.speak({ text: "نعم" })).wav);
  const long = wavSeconds(
    (await voice.speak({ text: "كلمة ".repeat(60) })).wav,
  );
  assert.equal(short, 1);
  assert.ok(long > 10);
});

test("the checks block a script the voice or renderer would get wrong", () => {
  const ok = Lesson.parse(lesson([title("a")]));
  assert.deepEqual(checkLesson(ok), []);

  const bad = Lesson.parse(
    lesson([
      title("empty", "..."),
      title("markup", "الناتج $x^2$ هو"),
      title("english", "This is entirely English narration."),
      {
        id: "eq",
        type: "equation_steps",
        title: "معادلة",
        steps: [{ latex: "\\frac{" }, { latex: "س + ص = ١٠" }],
        narration: "نحل المعادلة.",
      },
      {
        id: "fig",
        type: "figure",
        title: "شكل",
        image: "../secret.png",
        narration: "بص على الشكل.",
      },
    ]),
  );
  const found = checkLesson(bad).map((f) => `${f.level}:${f.scene_id ?? ""}`);
  assert.deepEqual(found.sort(), [
    "error:empty",
    "error:eq",
    "error:fig",
    "error:markup",
    "warning:english",
  ]);
});

test("a scene page is right to left, reveals in order and keeps maths as MathML", () => {
  const scene = Lesson.parse(
    lesson([
      {
        id: "eq",
        type: "equation_steps",
        title: "مثال <b>",
        steps: [
          { latex: "٢س + ٦ = ١٤" },
          { latex: "س = ٤", note: "نقسم على ٢" },
        ],
        narration: "نحل المعادلة. ثم نقسم.",
      },
    ]),
  ).scenes[0];
  assert.ok(scene);
  assert.equal(revealCount(scene), 2);
  const html = scenePage(scene, {
    duration: 7.5,
    reveals: [0.3, 2.25],
    audio: "narration.wav",
  });
  assert.match(html, /<html lang="ar" dir="rtl">/);
  assert.match(html, /data-composition-id="root"[^>]*data-duration="7.500"/);
  assert.match(html, /<math dir="rtl"/);
  assert.match(html, /data-at="2.250"/);
  assert.match(html, /<audio id="narration" src="narration.wav"/);
  assert.ok(!html.includes("<b>"), "on-screen text is escaped");
  assert.ok(!/https?:\/\//.test(html), "nothing is fetched while rendering");
});

function sse(chunks: string[]): Response {
  const body =
    chunks
      .map(
        (b64) =>
          `data: ${JSON.stringify({ choices: [{ delta: { audio: { data: b64 } } }] })}\n\n`,
      )
      .join("") + "data: [DONE]\n\n";
  return new Response(body, { status: 200 });
}

test("OpenRouter's streamed audio becomes one WAV, with the model from config", async () => {
  interface Sent {
    model: string;
    audio: { voice: string };
    messages: { role: string; content: string }[];
  }
  const sent: Sent[] = [];
  const voice = openRouterVoice({
    apiKey: "k",
    model: "some/voice-model",
    voice: "default-voice",
    style: "اقرأ بالمصرية",
    fetch: (_url, init) => {
      sent.push(JSON.parse(init?.body as string) as Sent);
      const half = Buffer.alloc(24000).toString("base64"); // 0.5 s of 24 kHz PCM16
      return Promise.resolve(sse([half, half]));
    },
  });
  const { wav } = await voice.speak({ text: "أهلاً" });
  assert.equal(wavSeconds(wav), 1);
  const [request] = sent;
  assert.ok(request);
  assert.equal(request.model, "some/voice-model");
  assert.equal(request.audio.voice, "default-voice");
  assert.deepEqual(
    request.messages.map((m) => m.role),
    ["system", "user"],
  );

  const failing = openRouterVoice({
    apiKey: "k",
    model: "m",
    voice: "v",
    style: "s",
    fetch: () => Promise.resolve(new Response("nope", { status: 403 })),
  });
  await assert.rejects(failing.speak({ text: "x" }), /403/);
  const empty = openRouterVoice({
    apiKey: "k",
    model: "m",
    voice: "v",
    style: "s",
    fetch: () => Promise.resolve(sse([])),
  });
  await assert.rejects(empty.speak({ text: "x" }), /no audio/);
});
