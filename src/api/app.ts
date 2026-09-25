import { Hono } from "hono";
import type { PgBoss } from "pg-boss";
import { authenticate, type Caller } from "../accounts/keys.ts";
import { CreateDocumentRequest } from "../contract/document.ts";
import {
  CreateOutlineRequest,
  ReplaceOutlineRequest,
} from "../contract/outline.ts";
import {
  documentView,
  getDocumentRow,
  type DocumentSource,
} from "../documents/store.ts";
import {
  confirmOutline,
  createOutline,
  getOutline,
  markInUse,
  outlineView,
  replaceOutline,
} from "../outline/store.ts";
import { normaliseTree } from "../outline/tree.ts";
import { admit } from "../pipeline/pipeline.ts";
import { addDays, type Clock } from "../shared/clock.ts";
import type { Db } from "../shared/db/pool.ts";
import { newId } from "../shared/ids.ts";
import { Refusal } from "../shared/refusal.ts";
import type { BlobStore } from "../storage/store.ts";
import {
  CreateUploadRequest,
  createUpload,
  finishedUpload,
  PDF,
} from "../uploads/uploads.ts";
import { errorResponse, readBody, unauthorized } from "./errors.ts";

export interface AppDeps {
  db: Db;
  boss: PgBoss;
  store: BlobStore & { routes?: Hono };
  clock: Clock;
}

/** Results, page images and exports are kept this long (spec §1 step 8). */
export const DOCUMENT_TTL_DAYS = 30;

interface Env {
  Variables: { caller: Caller };
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  const { db, store, clock } = deps;

  app.onError((error, c) => errorResponse(c, error));

  app.get("/v1/health", (c) => c.json({ status: "ok" }));

  if (store.routes) app.route("/local-storage", store.routes);

  const v1 = new Hono<Env>();
  v1.use(async (c, next) => {
    const caller = await authenticate(db, c.req.header("authorization"));
    if (!caller) return unauthorized(c);
    c.set("caller", caller);
    return next();
  });

  v1.post("/uploads", async (c) => {
    const body = await readBody(c, CreateUploadRequest);
    const upload = await createUpload(
      db,
      store,
      clock,
      c.var.caller.orgId,
      body,
    );
    return c.json(upload, 201);
  });

  v1.post("/outlines", async (c) => {
    const body = await readBody(c, CreateOutlineRequest);
    const nodes = normaliseTree(body.source.nodes);
    const outline = await createOutline(
      db,
      clock,
      c.var.caller.orgId,
      { type: body.source.type },
      nodes,
    );
    return c.json(outlineView(outline), 201);
  });

  v1.get("/outlines/:id", async (c) => {
    const outline = await getOutline(db, c.var.caller.orgId, c.req.param("id"));
    if (!outline)
      throw new Refusal("not_found", `No outline ${c.req.param("id")}.`);
    return c.json(outlineView(outline));
  });

  v1.put("/outlines/:id", async (c) => {
    const body = await readBody(c, ReplaceOutlineRequest);
    const outline = await replaceOutline(
      db,
      clock,
      c.var.caller.orgId,
      c.req.param("id"),
      normaliseTree(body.nodes),
    );
    return c.json(outlineView(outline));
  });

  v1.post("/outlines/:id/confirm", async (c) => {
    const outline = await confirmOutline(
      db,
      clock,
      c.var.caller.orgId,
      c.req.param("id"),
    );
    return c.json(outlineView(outline));
  });

  v1.post("/documents", async (c) => {
    const { orgId, apiKeyId } = c.var.caller;
    const body = await readBody(c, CreateDocumentRequest);

    const outline = await getOutline(db, orgId, body.outline_id);
    if (!outline)
      throw new Refusal("not_found", `No outline ${body.outline_id}.`);
    if (outline.status === "draft") {
      throw new Refusal(
        "outline_not_confirmed",
        "Confirm the outline before running a document against it.",
      );
    }

    let source: DocumentSource;
    if ("upload_id" in body.source) {
      const upload = await finishedUpload(
        db,
        store,
        orgId,
        body.source.upload_id,
      );
      if (upload.contentType !== PDF) {
        throw new Refusal(
          "unsupported_file",
          "`upload_id` takes a PDF. Send photos as `upload_ids`, in page order.",
        );
      }
      source = {
        kind: "pdf",
        upload_id: upload.id,
        storage_key: upload.storageKey,
      };
    } else {
      const uploads = [];
      for (const id of body.source.upload_ids) {
        const upload = await finishedUpload(db, store, orgId, id);
        if (upload.contentType === PDF) {
          throw new Refusal(
            "unsupported_file",
            "`upload_ids` takes photos, one page each. Send a PDF as `upload_id`.",
          );
        }
        uploads.push({ upload_id: upload.id, storage_key: upload.storageKey });
      }
      source = { kind: "images", uploads };
    }

    const id = newId("doc");
    const now = clock();
    await db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO documents
           (id, org_id, api_key_id, outline_id, type, language, status, source, webhook_url, created_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'queued', $7, $8, $9, $10)`,
        [
          id,
          orgId,
          apiKeyId,
          outline.id,
          body.type,
          body.language ?? null,
          JSON.stringify(source),
          body.webhook_url ?? null,
          now,
          addDays(now, DOCUMENT_TTL_DAYS),
        ],
      );
      await markInUse(tx, outline.id);
      await admit(deps.boss, tx, apiKeyId);
    });
    const row = await getDocumentRow(db, orgId, id);
    return c.json(
      { id, object: "document", status: row?.status ?? "queued" },
      202,
    );
  });

  v1.get("/documents/:id", async (c) => {
    const row = await getDocumentRow(db, c.var.caller.orgId, c.req.param("id"));
    if (!row)
      throw new Refusal("not_found", `No document ${c.req.param("id")}.`);
    return c.json(await documentView(db, store, row));
  });

  app.route("/v1", v1);
  return app;
}
