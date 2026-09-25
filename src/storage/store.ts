// Where Engines keeps bytes: uploads, page images and result files (spec #1 §6).
// Keys start with their area, which maps to one of the three buckets.
export type Area = "uploads" | "pages" | "results";

export interface BlobStore {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  /** Size of a finished object, or null when it doesn't exist (yet). */
  size(key: string): Promise<number | null>;
  delete(key: string): Promise<void>;
  /** Deletes every object whose key starts with `prefix`. */
  deletePrefix(prefix: string): Promise<void>;
  /** A time-limited URL anyone holding it can read the object from. */
  signedUrl(key: string, ttlSeconds: number): Promise<string>;
  /**
   * A resumable upload session for `key`: the client PUTs the bytes straight to
   * the returned URL, in one request or in chunks with `Content-Range`, the
   * Google Cloud Storage resumable protocol. Nothing large passes through the
   * API service, whose requests Cloud Run caps at 32 MB.
   */
  createUpload(key: string, contentType: string, size: number): Promise<string>;
}

export function areaOf(key: string): Area {
  const area = key.split("/", 1)[0];
  if (area === "uploads" || area === "pages" || area === "results") return area;
  throw new Error(`storage key "${key}" is in no known area`);
}
