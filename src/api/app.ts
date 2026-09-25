import { serveStatic } from "@hono/node-server/serve-static";
import { Hono, type Context } from "hono";
import type { PgBoss } from "pg-boss";
import { balance, ledger } from "../accounts/credits.ts";
import type { Auth } from "../accounts/auth.ts";
import { authenticateKey, type Caller } from "../accounts/keys.ts";
import { sessionCaller } from "../accounts/sessions.ts";
import {
  ConfirmOffsetRequest,
  CreateDocumentRequest,
} from "../contract/document.ts";
import {
  CreateOutlineRequest,
  ReplaceOutlineRequest,
} from "../contract/outline.ts";
import { createDocument, type Created } from "../documents/create.ts";
import { documentView, liveDocument } from "../documents/store.ts";
import { startOutline } from "../outline/start.ts";
import {
  confirmOutline,
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
import {
  EXPORT_FORMATS,
  exportDocument,
  type ExportFormat,
} from "../exports/export.ts";
import { chromiumPath } from "../exports/pdf.ts";
import { errorResponse, readBody, unauthorized } from "./errors.ts";
import { pageRoutes } from "./page.ts";
import { allowedOrigins, readSession } from "./page-session.ts";
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
  /** The Chromium binary for PDF exports; found on the usual paths when unset. */
  chromiumPath?: string | undefined;
  /** Sign-in on Engines' page. */
  auth: Auth;
  /** The built page (web/dist), served at `/` when set. */
  webDir?: string | undefined;
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

  const { auth } = deps;
  const session = {
    auth,
    db,
    origins: allowedOrigins(auth.options.baseURL, auth.options.trustedOrigins),
  };
  app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));
  app.route(
    "/page",
    pageRoutes({
      ...session,
      store,
      clock,
      google: auth.options.socialProviders !== undefined,
    }),
  );

  // An API key when one is sent; otherwise the person signed in to the page,
  // acting for their organisation.
  const v1 = new Hono<Env>();
  v1.use(async (c, next) => {
    const authorization = c.req.header("authorization");
    let caller: Caller | null = null;
    if (authorization !== undefined) {
      caller = await authenticateKey(db, authorization);
    } else {
      const signedIn = await readSession(session, c);
      if (signedIn) caller = await sessionCaller(db, signedIn);
    }
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
      const outline = await startOutline(deps, c.var.caller, body);
      return { status: 201, body: await outlineView(store, outline) };
    });
    // A repeat returns the outline as it is now (drafting moves on).
    if (response.replayed) {
      const { id } = response.body as { id: string };
      return c.json(await currentOutline(c.var.caller.orgId, id), 201);
    }
    return c.json(response.body, response.status as 201);
  });

  const currentOutline = async (orgId: string, id: string) => {
    const outline = await getOutline(db, orgId, id);
    if (!outline) throw new Refusal("not_found", `No outline ${id}.`);
    return outlineView(store, outline);
  };

  v1.get("/outlines/:id", async (c) =>
    c.json(await currentOutline(c.var.caller.orgId, c.req.param("id"))),
  );

  v1.put("/outlines/:id", async (c) => {
    const body = await readBody(c, ReplaceOutlineRequest);
    const outline = await replaceOutline(
      db,
      clock,
      c.var.caller.orgId,
      c.req.param("id"),
      normaliseTree(body.nodes),
    );
    return c.json(await outlineView(store, outline));
  });

  v1.post("/outlines/:id/confirm", async (c) => {
    const outline = await confirmOutline(
      db,
      clock,
      c.var.caller.orgId,
      c.req.param("id"),
    );
    return c.json(await outlineView(store, outline));
  });

  v1.post("/documents", async (c) => {
    const body = await readBody(c, CreateDocumentRequest);
    const response = await once(c, "POST /v1/documents", body, async () => ({
      status: 202,
      body: await createDocument(deps, c.var.caller, body),
    }));
    // A repeat returns the original document as it is now, not as it was.
    if (response.replayed) {
      const created = response.body as Created;
      const row = await liveDocument(db, c.var.caller.orgId, created.id);
      return c.json({ ...created, status: row.status }, 202);
    }
    return c.json(response.body, response.status as 202);
  });

  v1.get("/usage", async (c) => {
    const { orgId } = c.var.caller;
    return c.json({
      object: "usage",
      balance: await balance(db, orgId),
      ledger: await ledger(db, orgId),
    });
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
    const row = await liveDocument(db, c.var.caller.orgId, c.req.param("id"));
    return c.json(await documentView(db, store, row));
  });

  v1.get("/documents/:id/export", async (c) => {
    const format = c.req.query("format") ?? "json";
    if (!(EXPORT_FORMATS as readonly string[]).includes(format)) {
      throw new Refusal(
        "invalid_request",
        `format must be one of ${EXPORT_FORMATS.join(", ")}.`,
      );
    }
    const row = await liveDocument(db, c.var.caller.orgId, c.req.param("id"));
    const file = await exportDocument(
      { db, store, chromium: () => chromiumPath(deps.chromiumPath) },
      row,
      format as ExportFormat,
    );
    return c.body(new Uint8Array(file.bytes), 200, {
      "content-type": file.contentType,
      "content-disposition": `attachment; filename="${file.filename.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
    });
  });

  v1.get("/documents/:id", async (c) => {
    const row = await liveDocument(db, c.var.caller.orgId, c.req.param("id"));
    return c.json(await documentView(db, store, row));
  });

  app.route("/v1", v1);

  if (deps.webDir) {
    const root = deps.webDir;
    app.use("/assets/*", serveStatic({ root }));
    // Every other page path is the single-page app's; API paths stay 404.
    const index = serveStatic({ root, path: "index.html" });
    app.get("*", (c, next) =>
      /^\/(v1|api|page|local-storage)(\/|$)/.test(c.req.path)
        ? next()
        : index(c, next),
    );
  }
  return app;
}
