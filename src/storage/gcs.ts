// The Google Cloud Storage BlobStore: three buckets, one per area, with the
// lifecycle rules E-02 sets (uploads 2 days, pages and results 30 days).
import { Storage, type Bucket } from "@google-cloud/storage";
import { areaOf, type Area, type BlobStore } from "./store.ts";

export type GcsBuckets = Record<Area, string>;

export function gcsStore(buckets: GcsBuckets, origin?: string): BlobStore {
  const storage = new Storage();
  const bucketOf = (key: string): Bucket =>
    storage.bucket(buckets[areaOf(key)]);
  const file = (key: string) => bucketOf(key).file(key);

  return {
    async put(key, bytes, contentType) {
      await file(key).save(Buffer.from(bytes), {
        contentType,
        resumable: false,
      });
    },
    async get(key) {
      const [bytes] = await file(key).download();
      return bytes;
    },
    async size(key) {
      try {
        const [metadata] = await file(key).getMetadata();
        return Number(metadata.size);
      } catch (error) {
        if ((error as { code?: number }).code === 404) return null;
        throw error;
      }
    },
    async delete(key) {
      await file(key).delete({ ignoreNotFound: true });
    },
    async deletePrefix(prefix) {
      await bucketOf(prefix).deleteFiles({ prefix, force: true });
    },
    async signedUrl(key, ttlSeconds) {
      const [url] = await file(key).getSignedUrl({
        version: "v4",
        action: "read",
        expires: Date.now() + ttlSeconds * 1000,
      });
      return url;
    },
    async createUpload(key, contentType) {
      const [url] = await file(key).createResumableUpload({
        metadata: { contentType },
        ...(origin ? { origin } : {}),
      });
      return url;
    },
  };
}
