import type { StorageConfig } from "../shared/config.ts";
import { gcsStore } from "./gcs.ts";
import { localStore } from "./local.ts";
import type { BlobStore } from "./store.ts";
import type { Hono } from "hono";

export function storeFromConfig(
  config: StorageConfig,
): BlobStore & { routes?: Hono } {
  return config.kind === "local"
    ? localStore({
        dir: config.dir,
        publicUrl: config.publicUrl,
        secret: config.secret,
      })
    : gcsStore(config.buckets, config.publicUrl);
}
