// Mono 16-bit PCM WAV: just enough to measure a voice take and to write the
// silent take the scripted voice returns. Pure.

const HEADER = 44;

export interface Pcm {
  sampleRate: number;
  /** Little-endian 16-bit mono samples. */
  samples: Buffer;
}

export function encodeWav({ sampleRate, samples }: Pcm): Buffer {
  const header = Buffer.alloc(HEADER);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + samples.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(samples.length, 40);
  return Buffer.concat([header, samples]);
}

/** Seconds of audio in a WAV file this module wrote or a provider returned as PCM16 mono. */
export function wavSeconds(wav: Buffer): number {
  if (wav.length < HEADER || wav.toString("ascii", 0, 4) !== "RIFF")
    throw new Error("Not a WAV file.");
  let offset = 12;
  let sampleRate = 0;
  let bytesPerFrame = 0;
  while (offset + 8 <= wav.length) {
    const id = wav.toString("ascii", offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    if (id === "fmt ") {
      sampleRate = wav.readUInt32LE(offset + 12);
      bytesPerFrame = wav.readUInt16LE(offset + 20);
    } else if (id === "data") {
      if (sampleRate === 0 || bytesPerFrame === 0)
        throw new Error("WAV data before its format.");
      const length = Math.min(size, wav.length - offset - 8);
      return length / bytesPerFrame / sampleRate;
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error("WAV has no data.");
}

export function silence(seconds: number, sampleRate = 24000): Buffer {
  return encodeWav({
    sampleRate,
    samples: Buffer.alloc(Math.round(seconds * sampleRate) * 2),
  });
}
