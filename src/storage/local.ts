// The local-disk BlobStore for development and tests. It stands in for Google
// Cloud Storage, including signed URLs and the resumable upload protocol, which
// the API serves under /local-storage/ (see `localStorageRoutes`).
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  open,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { Hono } from "hono";
import { areaOf, type BlobStore } from "./store.ts";

export interface LocalStoreOptions {
  dir: string;
  /** Where the API is reachable, e.g. http://localhost:8080. */
  publicUrl: string;
  /** Signs URLs. Any random string; it never leaves this machine. */
  secret: string;
  now?: () => Date;
}

export interface LocalStore extends BlobStore {
  routes: Hono;
}

const UPLOAD_TTL_SECONDS = 7 * 24 * 3600;

export function localStore(options: LocalStoreOptions): LocalStore {
  const root = resolve(options.dir);
  const now = options.now ?? (() => new Date());

  const pathOf = (key: string): string => {
    areaOf(key);
    const path = resolve(root, key);
    if (!path.startsWith(root + sep))
      throw new Error(`storage key "${key}" escapes the store`);
    return path;
  };
  const partial = (key: string) => `${pathOf(key)}.partial`;
  const meta = (key: string) => `${pathOf(key)}.upload.json`;

  const sign = (payload: string) =>
    createHmac("sha256", options.secret).update(payload).digest("base64url");
  const verify = (payload: string, signature: string) => {
    const expected = Buffer.from(sign(payload));
    const given = Buffer.from(signature);
    return expected.length === given.length && timingSafeEqual(expected, given);
  };
  const signedQuery = (kind: string, key: string, ttl: number) => {
    const exp = String(Math.floor(now().getTime() / 1000) + ttl);
    const sig = sign(`${kind}\n${key}\n${exp}`);
    return new URLSearchParams({ key, exp, sig }).toString();
  };
  const checkQuery = (
    kind: string,
    query: Record<string, string>,
  ): string | null => {
    const { key, exp, sig } = query;
    if (!key || !exp || !sig) return null;
    if (Number(exp) * 1000 < now().getTime()) return null;
    return verify(`${kind}\n${key}\n${exp}`, sig) ? key : null;
  };

  const store: BlobStore = {
    async put(key, bytes) {
      const path = pathOf(key);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(`${path}.tmp`, bytes);
      await rename(`${path}.tmp`, path);
    },
    get: (key) => readFile(pathOf(key)),
    async size(key) {
      try {
        return (await stat(pathOf(key))).size;
      } catch {
        return null;
      }
    },
    async readRange(key, start, end) {
      const file = await open(pathOf(key), "r");
      try {
        const buffer = Buffer.alloc(Math.max(0, end - start));
        const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
        return buffer.subarray(0, bytesRead);
      } finally {
        await file.close();
      }
    },
    async fingerprint(key) {
      try {
        const hash = createHash("md5");
        for await (const chunk of createReadStream(pathOf(key)))
          hash.update(chunk as Buffer);
        return hash.digest("base64");
      } catch {
        return null;
      }
    },
    async delete(key) {
      await rm(pathOf(key), { force: true });
      await rm(partial(key), { force: true });
      await rm(meta(key), { force: true });
    },
    async deletePrefix(prefix) {
      await rm(pathOf(prefix.replace(/\/+$/, "")), {
        recursive: true,
        force: true,
      });
    },
    signedUrl(key, ttlSeconds) {
      return Promise.resolve(
        `${options.publicUrl}/local-storage/files?${signedQuery("get", key, ttlSeconds)}`,
      );
    },
    async createUpload(key, contentType, size) {
      await mkdir(dirname(pathOf(key)), { recursive: true });
      await writeFile(meta(key), JSON.stringify({ contentType, size }));
      await writeFile(partial(key), "");
      return `${options.publicUrl}/local-storage/uploads?${signedQuery("put", key, UPLOAD_TTL_SECONDS)}`;
    },
  };

  const routes = new Hono();

  routes.get("/files", async (c) => {
    const key = checkQuery("get", c.req.query());
    if (key === null) return c.text("forbidden", 403);
    try {
      const bytes = await store.get(key);
      return c.body(new Uint8Array(bytes), 200, {
        "content-type": contentTypeOf(key),
      });
    } catch {
      return c.text("not found", 404);
    }
  });

  // A subset of the GCS resumable protocol: a PUT carries bytes start-end of
  // total; a PUT with "bytes */total" and no body asks how much has arrived.
  // 308 means "incomplete", with a Range header saying what the server has.
  routes.put("/uploads", async (c) => {
    const key = checkQuery("put", c.req.query());
    if (key === null) return c.text("forbidden", 403);

    let declared: { size: number };
    try {
      declared = JSON.parse(await readFile(meta(key), "utf8")) as {
        size: number;
      };
    } catch {
      if ((await store.size(key)) !== null) return c.body(null, 200);
      return c.text("no such upload", 404);
    }

    const received = (await stat(partial(key))).size;
    const range = c.req.header("content-range");
    const incomplete = (have: number) =>
      c.body(
        null,
        308,
        have > 0 ? { range: `bytes=0-${String(have - 1)}` } : {},
      );

    const body = new Uint8Array(await c.req.arrayBuffer());
    let start = 0;
    let total = declared.size;
    if (range) {
      const status = /^bytes \*\/(\d+)$/.exec(range);
      if (status)
        return received === Number(status[1]) ? finish() : incomplete(received);
      const chunk = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(range);
      if (!chunk) return c.text("bad Content-Range", 400);
      start = Number(chunk[1]);
      if (chunk[3] !== "*") total = Number(chunk[3]);
      if (Number(chunk[2]) - start + 1 !== body.length)
        return c.text("Content-Range does not match the body", 400);
      if (Number(chunk[2]) >= total)
        return c.text("Content-Range ends past the declared size", 400);
    } else {
      total = body.length;
    }
    if (total !== declared.size)
      return c.text(`upload declared ${String(declared.size)} bytes`, 400);
    if (start !== received) return incomplete(received);

    const file = await open(partial(key), "a");
    try {
      await file.write(body);
    } finally {
      await file.close();
    }
    return received + body.length >= total
      ? finish()
      : incomplete(received + body.length);

    async function finish() {
      if (key === null) throw new Error("unreachable");
      await rename(partial(key), pathOf(key));
      await rm(meta(key), { force: true });
      return c.body(null, 200);
    }
  });

  return { ...store, routes };
}

function contentTypeOf(key: string): string {
  if (key.endsWith(".png")) return "image/png";
  if (key.endsWith(".jpg") || key.endsWith(".jpeg")) return "image/jpeg";
  if (key.endsWith(".pdf")) return "application/pdf";
  if (key.endsWith(".json")) return "application/json";
  return "application/octet-stream";
}
