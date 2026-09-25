import { Hono, type Context } from "hono";
import type { PgBoss } from "pg-boss";
import { authenticate, type Caller } from "../accounts/keys.ts";
import {
  ConfirmOffsetRequest,
  CreateDocumentRequest,
} from "../contract/document.ts";
import {
  CreateOutlineRequest,
  ReplaceOutlineRequest,
} from "../contract/outline.ts";
import { createDocument } from "../documents/create.ts";
import { documentView, getDocumentRow } from "../documents/store.ts";
import {
  confirmOutline,
  createOutline,
  getOutline,
  outlineView,
  replaceOutline,
} from "../outline/store.ts";
import { normaliseTree } from "../outline/tree.ts";
import { confirmOffset } from "../pipeline/pipeline.ts";
import type { Clock } from "../shared/clock.ts";
import type { Db } from "../shared/db/pool.ts";
import { Refusal } from "../shared/refusal.ts";
import type { BlobStore } from "../storage/store.ts";
import type { TargetPolicy } from "../webhooks/target.ts";
import { CreateUploadRequest, createUpload } from "../uploads/uploads.ts";
import { webhookSecret } from "../webhooks/deliver.ts";
import { errorResponse, readBody, unauthorized } from "./errors.ts";
import {
  IDEMPOTENCY_HEADER,
  withIdempotency,
  type Stored,
} from "./idempotency.ts";

export interface AppDeps {
  db: Db;
  boss: PgBoss;
  store: BlobStore & { routes?: Hono };
  clock: Clock;
  webhooks: TargetPolicy;
}

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

  /** Runs a create at most once per Idempotency-Key (24 h). */
  const once = (
    c: Context<Env>,
    route: string,
    body: unknown,
    run: () => Promise<Stored>,
  ) =>
    withIdempotency(
      db,
      clock,
      {
        orgId: c.var.caller.orgId,
        key: c.req.header(IDEMPOTENCY_HEADER),
        route,
        body,
      },
      run,
    );

  v1.post("/outlines", async (c) => {
    const body = await readBody(c, CreateOutlineRequest);
    const response = await once(c, "POST /v1/outlines", body, async () => {
      const nodes = normaliseTree(body.source.nodes);
      const outline = await createOutline(
        db,
        clock,
        c.var.caller.orgId,
        { type: body.source.type },
        nodes,
      );
      return { status: 201, body: outlineView(outline) };
    });
    return c.json(response.body, response.status as 201);
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
    const body = await readBody(c, CreateDocumentRequest);
    const response = await once(c, "POST /v1/documents", body, async () => ({
      status: 202,
      body: await createDocument(deps, c.var.caller, body),
    }));
    return c.json(response.body, response.status as 202);
  });

  v1.get("/webhook_secret", async (c) => {
    return c.json({
      object: "webhook_secret",
      secret: await webhookSecret(db, c.var.caller.orgId),
    });
  });

  v1.post("/documents/:id/offset", async (c) => {
    const body = await readBody(c, ConfirmOffsetRequest);
    await confirmOffset(
      deps,
      c.var.caller.orgId,
      c.req.param("id"),
      body.segments,
    );
    const row = await getDocumentRow(db, c.var.caller.orgId, c.req.param("id"));
    if (!row)
      throw new Refusal("not_found", `No document ${c.req.param("id")}.`);
    return c.json(await documentView(db, store, row));
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
