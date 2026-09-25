// Step 3 of the flow (spec §1): edit the drafted tree and confirm it. Every
// node needs a printed page range; the same validation as the API shows its
// errors and warnings inline, and "Confirm tree" waits until there are no
// errors. Changes save as they're made.
import {
  createOnDropHandler,
  dragAndDropFeature,
  selectionFeature,
  syncDataLoaderFeature,
  type DragTarget,
  type ItemInstance,
} from "@headless-tree/core";
import { useTree } from "@headless-tree/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Outline, OutlineIssue } from "../../../src/contract/outline.ts";
import { validateOutline } from "../../../src/outline/tree.ts";
import { api } from "../api.ts";
import { fill, useI18n } from "../i18n.tsx";
import { NumberInput } from "../NumberInput.tsx";
import { Link, query } from "../router.tsx";
import {
  addNode,
  flatten,
  nest,
  removeNode,
  ROOT,
  setChildren,
  updateNode,
  type FlatTree,
  type NodeFields,
} from "../tree-model.ts";
import type { Organisation } from "./OrganisationShell.tsx";

const SAVE_AFTER_MS = 600;
/** One level of nesting; Headless Tree needs it to tell levels apart when dropping. */
const INDENT_PX = 28;
const POLL_MS = 1500;

type SaveState = "saved" | "saving" | { error: string };

export function OutlineEditor(props: {
  organisation: Organisation;
  outlineId: string;
}) {
  const { t } = useI18n();
  const orgId = props.organisation.id;
  const path = `/v1/outlines/${props.outlineId}`;
  const [outline, setOutline] = useState<Outline | null>(null);
  const [flat, setFlat] = useState<FlatTree | null>(null);
  // The latest tree, for edits made before React re-renders.
  const latest = useRef<FlatTree | null>(null);
  const [save, setSave] = useState<SaveState>("saved");
  const [error, setError] = useState<string | null>(null);

  // Load, and keep polling while the tree is still being drafted.
  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const next = await api<Outline>("GET", path, { orgId });
        if (stop) return;
        setOutline(next);
        setError(null);
        if (next.drafting?.status === "running") {
          timer = setTimeout(() => void load(), POLL_MS);
        } else {
          latest.current = flatten(next.nodes);
          setFlat(latest.current);
        }
      } catch (e) {
        if (stop) return;
        setError(e instanceof Error ? e.message : String(e));
        // Keep trying: drafting goes on without the page.
        timer = setTimeout(() => void load(), POLL_MS * 2);
      }
    };
    void load();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
    // Loaded once per outline: reloading would drop edits not yet saved.
  }, [path, orgId]);

  // Saves go one at a time, each sending the latest tree, so a slow save
  // can never land after a newer one.
  const pending = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const dirty = useRef(false);
  const saving = useRef<Promise<void> | null>(null);
  const flush = useCallback((): Promise<void> => {
    clearTimeout(pending.current);
    saving.current ??= (async () => {
      try {
        while (dirty.current && latest.current) {
          dirty.current = false;
          await api<Outline>("PUT", path, {
            orgId,
            body: { nodes: nest(latest.current) },
          });
        }
        setSave("saved");
      } catch (e) {
        setSave({ error: e instanceof Error ? e.message : String(e) });
        throw e;
      } finally {
        saving.current = null;
      }
    })();
    const current = saving.current;
    // Changes made while a save was running go in the next one.
    return current.then(() => (dirty.current ? flush() : undefined));
  }, [path, orgId]);

  const edit = useCallback(
    (change: (tree: FlatTree) => FlatTree) => {
      if (!latest.current) return;
      const next = change(latest.current);
      latest.current = next;
      setFlat(next);
      clearTimeout(pending.current);
      // A node without a name isn't saved until it has one.
      if (unnamed(next)) {
        setSave({ error: t.nameNeeded });
        return;
      }
      dirty.current = true;
      setSave("saving");
      pending.current = setTimeout(() => {
        flush().catch(() => undefined);
      }, SAVE_AFTER_MS);
    },
    [flush, t.nameNeeded],
  );

  const validation = useMemo(
    () => (flat ? validateOutline(nest(flat)) : { errors: [], warnings: [] }),
    [flat],
  );

  async function confirm() {
    setError(null);
    try {
      dirty.current = true;
      await flush();
      setOutline(await api<Outline>("POST", `${path}/confirm`, { orgId }));
      setSave("saved");
    } catch (e) {
      setError(e instanceof Error ? e.message : t.error);
    }
  }

  if (error && !outline)
    return (
      <p className="error" role="alert">
        {error}
      </p>
    );
  if (!outline) return <p className="muted">{t.loading}</p>;

  const drafting = outline.drafting;
  const frozen = outline.status !== "draft";
  const next = new URLSearchParams({
    type: query("type") ?? "questions",
    ...(query("book") ? { book: query("book") ?? "" } : {}),
  });

  return (
    <div className="editor-layout">
      <section className="card editor">
        <h1>{t.tree}</h1>
        {drafting?.status === "running" ? (
          <div role="status">
            <p>{t.drafting}</p>
            <progress value={drafting.pages_read} max={drafting.pages} />
            {error && <p className="error small">{error}</p>}
            <p className="muted small">
              {fill(t.draftingProgress, {
                read: drafting.pages_read,
                total: drafting.pages,
              })}
            </p>
          </div>
        ) : (
          flat && (
            <>
              {drafting?.status === "failed" && (
                <p className="warning">{t.draftFailed}</p>
              )}
              {drafting?.failures.map((f) => (
                <p key={f.page} className="warning small">
                  {fill(t.pageFailed, { page: f.page })}
                </p>
              ))}
              <p className="muted small">{t.printedPagesHint}</p>
              <TreeEditor
                flat={flat}
                frozen={frozen}
                issues={[...validation.errors, ...validation.warnings]}
                edit={edit}
              />
              {!frozen && (
                <div className="row toolbar">
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => {
                      edit((tree) => addNode(tree, ROOT).tree);
                    }}
                  >
                    {t.addNode}
                  </button>
                  {!Object.values(flat.fields).some(
                    (n) => n.kind === "answer_key",
                  ) && (
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => {
                        edit(
                          (tree) =>
                            addNode(tree, ROOT, {
                              kind: "answer_key",
                              name: t.answerKey,
                            }).tree,
                        );
                      }}
                    >
                      {t.addAnswerKey}
                    </button>
                  )}
                </div>
              )}
              <div className="row status-line">
                {validation.errors.length > 0 && (
                  <span className="error">
                    {fill(t.errorsLeft, { n: validation.errors.length })}
                  </span>
                )}
                {validation.warnings.length > 0 && (
                  <span className="warning">
                    {fill(t.warningsLeft, { n: validation.warnings.length })}
                  </span>
                )}
                {!frozen && (
                  <span className="muted small" data-testid="save-state">
                    {save === "saved"
                      ? t.saved
                      : save === "saving"
                        ? t.saving
                        : save.error}
                  </span>
                )}
              </div>
              {error && (
                <p className="error" role="alert">
                  {error}
                </p>
              )}
              {frozen ? (
                <div className="row">
                  <strong>{t.confirmed}</strong>
                  <Link
                    className="button-like"
                    to={`/o/${orgId}/upload/${outline.id}?${next.toString()}`}
                  >
                    {t.nextUpload}
                  </Link>
                </div>
              ) : (
                <button
                  type="button"
                  disabled={
                    validation.errors.length > 0 ||
                    Object.keys(flat.fields).length === 0 ||
                    typeof save === "object"
                  }
                  onClick={() => void confirm()}
                >
                  {t.confirmTree}
                </button>
              )}
            </>
          )
        )}
      </section>
      {outline.source_pages.length > 0 && (
        <aside className="card source" aria-label={t.source}>
          <h2>{t.source}</h2>
          {outline.source_pages.map((page) =>
            page.image_url ? (
              <img
                key={page.page}
                src={page.image_url}
                loading="lazy"
                alt={fill(t.sourcePage, { page: page.page })}
              />
            ) : null,
          )}
        </aside>
      )}
    </div>
  );
}

function unnamed(tree: FlatTree): boolean {
  return Object.values(tree.fields).some((n) => n.name.trim() === "");
}

/** The tree itself: drag to reorder or re-parent, every field inline. */
function TreeEditor(props: {
  flat: FlatTree;
  frozen: boolean;
  issues: OutlineIssue[];
  edit: (change: (tree: FlatTree) => FlatTree) => void;
}) {
  const { t } = useI18n();
  const { flat, edit, frozen } = props;
  const all = useMemo(() => Object.keys(flat.fields), [flat]);
  // Every node with children stays open. (An open node only takes drops
  // above it or inside it, so a leaf stays closed: it takes drops below it
  // too.) A new array each render would make Headless Tree rebuild while
  // rendering, so it only changes with the tree.
  const state = useMemo(
    () => ({
      expandedItems: [
        ROOT,
        ...all.filter((id) => (flat.children[id] ?? []).length > 0),
      ],
    }),
    [all, flat],
  );

  const tree = useTree<NodeFields | null>({
    rootItemId: ROOT,
    getItemName: (item) => item.getItemData()?.name ?? "",
    // Any node can take children, so every node is a drop target.
    isItemFolder: () => true,
    state,
    setExpandedItems: () => undefined,
    dataLoader: {
      getItem: (id) => flat.fields[id] ?? null,
      getChildren: (id) => flat.children[id] ?? [],
    },
    // Headless Tree picks the level of a drop at the end of a list from the
    // pointer's distance to the left edge, which right-to-left mirrors. Moving
    // a node out a level therefore works by dropping it above a node of that
    // level, or into its new parent.
    canReorder: true,
    canDrag: () => !frozen,
    canDrop: (items, target) => !frozen && !intoItself(items, target),
    seperateDragHandle: true,
    onDrop: createOnDropHandler((item, children) => {
      edit((current) => setChildren(current, item.getId(), children));
    }),
    indent: INDENT_PX,
    features: [syncDataLoaderFeature, selectionFeature, dragAndDropFeature],
  });
  useEffect(() => {
    tree.rebuildTree();
  }, [flat, tree]);

  const byNode = new Map<string, OutlineIssue[]>();
  for (const issue of props.issues) {
    if (issue.node_id === null) continue;
    byNode.set(issue.node_id, [...(byNode.get(issue.node_id) ?? []), issue]);
  }

  if (all.length === 0) return <p className="muted">{t.emptyTree}</p>;
  return (
    <div {...tree.getContainerProps()} className="tree">
      {tree.getItems().map((item) => {
        const node = item.getItemData();
        if (!node) return null;
        const issues = byNode.get(node.id) ?? [];
        const range = node.printed_pages;
        const setRange = (from: number | null, to: number | null) => {
          edit((current) =>
            updateNode(current, node.id, {
              printed_pages:
                from === null && to === null
                  ? null
                  : { from: from ?? to ?? 1, to: to ?? from ?? 1 },
            }),
          );
        };
        const classes = [
          "tree-node",
          item.isDragTargetAbove() ? "drop-above" : "",
          item.isDragTargetBelow() ? "drop-below" : "",
          item.isUnorderedDragTarget() ? "drop-inside" : "",
          issues.some((i) => i.code !== "gap") ? "has-error" : "",
        ].join(" ");
        return (
          <div
            {...item.getProps()}
            key={item.getId()}
            className={classes}
            style={{
              paddingInlineStart: `${String(item.getItemMeta().level * INDENT_PX)}px`,
            }}
          >
            <div className="node-fields">
              {!frozen && (
                <span
                  {...item.getDragHandleProps()}
                  className="drag-handle"
                  role="button"
                  tabIndex={-1}
                  aria-label={t.dragHandle}
                  title={t.dragHandle}
                >
                  ⋮⋮
                </span>
              )}
              <input
                className="node-name"
                dir="auto"
                aria-label={t.nodeName}
                value={node.name}
                readOnly={frozen}
                aria-invalid={node.name.trim() === ""}
                onChange={(e) => {
                  edit((current) =>
                    updateNode(current, node.id, { name: e.target.value }),
                  );
                }}
              />
              {node.kind === "answer_key" ? (
                <span className="badge">{t.answerKey}</span>
              ) : (
                <input
                  className="node-level"
                  dir="auto"
                  aria-label={t.nodeLevel}
                  placeholder={t.levelPlaceholder}
                  value={node.level ?? ""}
                  readOnly={frozen}
                  onChange={(e) => {
                    edit((current) =>
                      updateNode(current, node.id, {
                        level: e.target.value === "" ? null : e.target.value,
                      }),
                    );
                  }}
                />
              )}
              <span className="range">
                <NumberInput
                  label={`${t.from} (${node.name})`}
                  value={range?.from ?? null}
                  invalid={issues.some((i) => i.code !== "gap")}
                  onChange={(from) => {
                    setRange(from, range?.to ?? null);
                  }}
                />
                <span aria-hidden="true">–</span>
                <NumberInput
                  label={`${t.to} (${node.name})`}
                  value={range?.to ?? null}
                  invalid={issues.some((i) => i.code !== "gap")}
                  onChange={(to) => {
                    setRange(range?.from ?? null, to);
                  }}
                />
              </span>
              {!frozen && (
                <span className="node-actions">
                  <button
                    type="button"
                    className="secondary small"
                    onClick={() => {
                      edit((current) => addNode(current, node.id).tree);
                    }}
                  >
                    {t.addChild}
                  </button>
                  <button
                    type="button"
                    className="danger small"
                    aria-label={`${t.remove} (${node.name})`}
                    onClick={() => {
                      edit((current) => removeNode(current, node.id));
                    }}
                  >
                    ×
                  </button>
                </span>
              )}
            </div>
            {issues.length > 0 && (
              <ul className="issues">
                {issues.map((issue, i) => (
                  <li
                    key={`${issue.code}-${String(i)}`}
                    className={issue.code === "gap" ? "warning" : "error"}
                  >
                    {t.issues?.[issue.code]
                      ? fill(t.issues[issue.code] ?? "", { name: node.name })
                      : issue.message}
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** A node can't be dropped into itself or its own descendants. */
function intoItself(
  items: ItemInstance<NodeFields | null>[],
  target: DragTarget<NodeFields | null>,
): boolean {
  const dragged = new Set(items.map((i) => i.getId()));
  for (
    let at: ItemInstance<NodeFields | null> | undefined = target.item;
    at;
    at = at.getParent()
  ) {
    if (dragged.has(at.getId())) return true;
  }
  return false;
}
