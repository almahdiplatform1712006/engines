// The voice seam: text in, a WAV take out. Two adapters, as for the page reader:
// the real voice through OpenRouter, and a scripted one for tests and dry runs
// (a silent take as long as the text would take to say).
import { encodeWav, silence } from "./wav.ts";

export interface VoiceInput {
  text: string;
  /** The provider's voice name; the adapter's default when unset. */
  voice?: string | undefined;
}

export interface VoiceTake {
  /** Mono 16-bit PCM WAV. */
  wav: Buffer;
}

export interface Voice {
  speak(input: VoiceInput): Promise<VoiceTake>;
}

/** About how long Egyptian Arabic takes to say: letters per second. */
const LETTERS_PER_SECOND = 13;

/** A silent take, as long as the text should take to say. For tests and dry runs. */
export function scriptedVoice(): Voice {
  return {
    speak: ({ text }) => {
      const letters = text.match(/[\p{L}\p{N}]/gu)?.length ?? 0;
      return Promise.resolve({
        wav: silence(Math.max(1, letters / LETTERS_PER_SECOND)),
      });
    },
  };
}

export interface OpenRouterVoiceOptions {
  apiKey: string;
  /** Set in config, never at a call site. */
  model: string;
  voice: string;
  /** Said to the voice as direction, not read aloud. */
  style: string;
  fetch?: typeof fetch;
}

/** OpenAI's PCM16 output rate, which OpenRouter passes through. */
const PCM_RATE = 24000;

/**
 * Audio output through OpenRouter's chat completions (streamed PCM16 chunks).
 * Not yet run against the live service: this environment cannot reach it.
 */
export function openRouterVoice(options: OpenRouterVoiceOptions): Voice {
  const send = options.fetch ?? fetch;
  return {
    async speak({ text, voice }) {
      const response = await send(
        "https://openrouter.ai/api/v1/chat/completions",
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${options.apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: options.model,
            modalities: ["text", "audio"],
            audio: { voice: voice ?? options.voice, format: "pcm16" },
            stream: true,
            messages: [
              { role: "system", content: options.style },
              { role: "user", content: text },
            ],
          }),
        },
      );
      if (!response.ok || !response.body)
        throw new Error(
          `Voice request failed: ${String(response.status)} ${await response.text()}`,
        );
      const chunks = await readAudioChunks(response.body);
      if (chunks.length === 0) throw new Error("The voice returned no audio.");
      return {
        wav: encodeWav({
          sampleRate: PCM_RATE,
          samples: Buffer.concat(chunks),
        }),
      };
    },
  };
}

interface StreamChunk {
  choices?: { delta?: { audio?: { data?: string } } }[];
  error?: { message?: string };
}

async function readAudioChunks(
  body: ReadableStream<Uint8Array>,
): Promise<Buffer[]> {
  const chunks: Buffer[] = [];
  const decoder = new TextDecoder();
  let pending = "";
  const take = (line: string) => {
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (data === "" || data === "[DONE]") return;
    const chunk = JSON.parse(data) as StreamChunk;
    if (chunk.error)
      throw new Error(chunk.error.message ?? "Voice stream error.");
    for (const choice of chunk.choices ?? []) {
      const audio = choice.delta?.audio?.data;
      if (audio) chunks.push(Buffer.from(audio, "base64"));
    }
  };
  for await (const part of body) {
    pending += decoder.decode(part, { stream: true });
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    lines.forEach(take);
  }
  take(pending);
  return chunks;
}
