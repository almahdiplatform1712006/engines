// What a visit may do on `/v1/` (E-21): upload a book, read, edit and confirm
// its outline, run documents on it and read, fix and export those; or read,
// fix and export its one document. Anything else is refused: another
// outline or document is `404` (it isn't there, for a visit), any other route
// `403`.
import type { Context } from "hono";
import { visitReaches, type Visit } from "../accounts/visits.ts";
import type { Queryable } from "../shared/db/pool.ts";
import { Refusal } from "../shared/refusal.ts";

export async function checkVisit(
  db: Queryable,
  visit: Visit,
  c: Context,
): Promise<void> {
  const method = c.req.method;
  const path = c.req.path.replace(/^\/v1/, "");
  const reach = async (target: { outlineId?: string; documentId?: string }) => {
    if (!(await visitReaches(db, visit, target)))
      throw new Refusal("not_found", "Not found.");
  };

  if (method === "POST" && path === "/uploads") return;

  const outline = /^\/outlines\/([^/]+)(\/confirm)?$/.exec(path);
  if (outline?.[1] && (method === "GET" || method === "PUT" || outline[2])) {
    await reach({ outlineId: outline[1] });
    return;
  }

  if (method === "POST" && path === "/documents") {
    // The book runs on the visit's own outline only.
    const body = (await c.req.json().catch(() => null)) as {
      outline_id?: unknown;
    } | null;
    if (visit.outlineId === null || body?.outline_id !== visit.outlineId)
      throw new Refusal("not_found", "Not found.");
    return;
  }

  const document = /^\/documents\/([^/]+)(\/(offset|revisions|export))?$/.exec(
    path,
  );
  if (document?.[1]) {
    await reach({ documentId: document[1] });
    return;
  }

  throw new Refusal(
    "forbidden",
    "A visit reaches only its outline or document.",
  );
}
