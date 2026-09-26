// Step 7 of the flow (spec §1): results under the confirmed tree, and one-click
// fixes. Each fix is saved as the next revision straight away (the original
// is never overwritten, and the webhook says which revision is new). Review
// is optional: nothing here holds up exports or the webhook.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { CropBox } from "../../../src/contract/crop.ts";
import type {
  Document,
  ExplanationChunk,
  Failure,
  Question,
} from "../../../src/contract/document.ts";
import type { Outline, OutlineNode } from "../../../src/contract/outline.ts";
import { MIN_CROP, type Change } from "../../../src/contract/revision.ts";
import { api, ApiError } from "../api.ts";
import { CropEditor } from "../CropEditor.tsx";
import { plain } from "../errors.ts";
import { fill, useI18n } from "../i18n.tsx";
import { RichText } from "../RichText.tsx";
import type { Organisation } from "./OrganisationShell.tsx";

const UNPLACED = "__unplaced__";

interface Focus {
  pdfPage: number;
  /** The item being recropped, when it is. */
  recrop: { id: string; figure?: number } | null;
}

export function Review(props: {
  organisation: Organisation;
  documentId: string;
}) {
  const { t } = useI18n();
  const orgId = props.organisation.id;
  const [doc, setDoc] = useState<Document | null>(null);
  const [outline, setOutline] = useState<Outline | null>(null);
  const [node, setNode] = useState<string | null>(null);
  const [focus, setFocus] = useState<Focus | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const loaded = await api<Document>(
          "GET",
          `/v1/documents/${props.documentId}`,
          { orgId },
        );
        setDoc(loaded);
        setOutline(
          await api<Outline>("GET", `/v1/outlines/${loaded.outline_id}`, {
            orgId,
          }),
        );
      } catch (e) {
        setError(e);
      }
    })();
  }, [props.documentId, orgId]);

  /**
   * Saves one fix as the next revision, made on the revision shown: if the
   * document moved on (another tab), the save is refused and the latest shown.
   */
  const save = useCallback(
    async (change: Change): Promise<boolean> => {
      if (!doc) return false;
      setSaving(true);
      setError(null);
      try {
        setDoc(
          await api<Document>(
            "POST",
            `/v1/documents/${props.documentId}/revisions`,
            {
              orgId,
              body: { base_revision: doc.revision, changes: [change] },
            },
          ),
        );
        return true;
      } catch (e) {
        setError(e);
        if (e instanceof ApiError && e.status === 409) {
          setDoc(
            await api<Document>("GET", `/v1/documents/${props.documentId}`, {
              orgId,
            }),
          );
        }
        return false;
      } finally {
        setSaving(false);
      }
    },
    [doc, props.documentId, orgId],
  );

  if (!doc || !outline)
    return error ? (
      <p className="error" role="alert">
        {plain(error, t)}
      </p>
    ) : (
      <p className="muted">{t.loading}</p>
    );

  const pageUrl = (pdfPage: number) =>
    `/page/documents/${doc.id}/pages/${String(pdfPage)}?org=${encodeURIComponent(orgId)}`;
  const context: ItemContext = {
    doc,
    outline,
    save,
    saving,
    orgId,
    show: (pdfPage, recrop = null) => {
      setFocus({ pdfPage, recrop });
    },
  };

  return (
    <div className="review-layout">
      <nav className="card review-tree" aria-label={t.tree}>
        <p className="muted small" data-testid="revision">
          {fill(t.revisionN, { n: doc.revision })}
        </p>
        <NodeList
          nodes={outline.nodes}
          doc={doc}
          selected={node}
          onSelect={setNode}
        />
        <button
          type="button"
          className={node === UNPLACED ? "node-link selected" : "node-link"}
          onClick={() => {
            setNode(UNPLACED);
          }}
        >
          {t.unplaced} <span className="badge">{doc.failures.length}</span>
        </button>
      </nav>

      <section className="card review-items">
        {error !== null && (
          <p className="error" role="alert">
            {plain(error, t)}
          </p>
        )}
        {node === null ? (
          <p className="muted">{t.pickNode}</p>
        ) : node === UNPLACED ? (
          <Unplaced context={context} />
        ) : (
          <NodeItems nodeId={node} context={context} />
        )}
      </section>

      {focus && (
        <aside className="card review-page" aria-label={t.pageImage}>
          <PagePanel
            key={`${String(focus.pdfPage)}-${focus.recrop?.id ?? ""}`}
            focus={focus}
            src={pageUrl(focus.pdfPage)}
            save={save}
            saving={saving}
            onDone={() => {
              setFocus({ ...focus, recrop: null });
            }}
          />
        </aside>
      )}
    </div>
  );
}

interface ItemContext {
  doc: Document;
  outline: Outline;
  orgId: string;
  saving: boolean;
  save: (change: Change) => Promise<boolean>;
  show: (pdfPage: number, recrop?: Focus["recrop"]) => void;
}

/** The tree, with each node's item and flag counts. */
function NodeList(props: {
  nodes: OutlineNode[];
  doc: Document;
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const counts = (id: string) => {
    const items = [
      ...props.doc.questions.filter((q) => q.node_id === id),
      ...(props.doc.explanation ?? []).filter((c) => c.node_id === id),
    ];
    return {
      items: items.length,
      flags: items.filter((i) => i.review_required).length,
    };
  };
  return (
    <ul className="node-list">
      {props.nodes.map((n) => {
        const { items, flags } = counts(n.id);
        return (
          <li key={n.id}>
            <button
              type="button"
              className={
                props.selected === n.id ? "node-link selected" : "node-link"
              }
              onClick={() => {
                props.onSelect(n.id);
              }}
            >
              <span dir="auto">{n.name}</span>{" "}
              <span className="badge">{items}</span>
              {flags > 0 && (
                <span className="badge flag" data-testid="flag-count">
                  ⚑ {flags}
                </span>
              )}
            </button>
            {n.children.length > 0 && (
              <NodeList {...props} nodes={n.children} />
            )}
          </li>
        );
      })}
    </ul>
  );
}

function NodeItems(props: { nodeId: string; context: ItemContext }) {
  const { t } = useI18n();
  const { doc } = props.context;
  const questions = doc.questions.filter((q) => q.node_id === props.nodeId);
  const chunks = (doc.explanation ?? []).filter(
    (c) => c.node_id === props.nodeId,
  );
  // Each passage once, above the questions linked to it; a passage of this
  // node with none linked still shows, so it can be recropped or deleted.
  const stimuli = doc.stimuli.filter(
    (s) =>
      s.node_id === props.nodeId ||
      questions.some((q) => q.stimulus_id === s.id),
  );
  const loose = questions.filter((q) => q.stimulus_id === null);
  if (questions.length === 0 && chunks.length === 0 && stimuli.length === 0)
    return <p className="muted">{t.nothingHere}</p>;
  return (
    <>
      {stimuli.map((s) => (
        <div key={s.id} className="stimulus-group">
          <div className="stimulus">
            {s.text && <RichText text={s.text} block />}
            {s.image && <img src={s.image.url} alt="" loading="lazy" />}
            <div className="row">
              <button
                type="button"
                className="secondary small"
                onClick={() => {
                  props.context.show(s.image?.pdf_page ?? s.pages[0] ?? 1, {
                    id: s.id,
                  });
                }}
              >
                {t.recrop}
              </button>
              <button
                type="button"
                className="danger small"
                disabled={props.context.saving}
                onClick={() => {
                  if (confirm(t.confirmDelete))
                    void props.context.save({ op: "delete", id: s.id });
                }}
              >
                {t.delete}
              </button>
            </div>
          </div>
          {questions
            .filter((q) => q.stimulus_id === s.id)
            .map((q) => (
              <QuestionCard key={q.id} question={q} context={props.context} />
            ))}
        </div>
      ))}
      {loose.map((q) => (
        <QuestionCard key={q.id} question={q} context={props.context} />
      ))}
      {chunks.map((c) => (
        <ChunkCard key={c.id} chunk={c} context={props.context} />
      ))}
    </>
  );
}

function reasonLabel(t: ReturnType<typeof useI18n>["t"], reason: string) {
  const labels: Record<string, string | undefined> = t.reasons;
  return labels[reason] ?? reason;
}

function QuestionCard(props: { question: Question; context: ItemContext }) {
  const { t } = useI18n();
  const { question: q, context } = props;
  const [editing, setEditing] = useState(false);
  const rtl = q.math_direction === "rtl";
  return (
    <article
      className={q.review_required ? "item flagged" : "item"}
      data-testid="question"
    >
      <header className="row spread">
        <span className="muted small">
          {t.questionTypes[q.type]} {q.number && `· ${q.number}`}
        </span>
        <span className="row">
          {q.answer_source && (
            <span className="badge">{t.sources[q.answer_source]}</span>
          )}
          {q.review_reason && (
            <span className="badge flag">
              {reasonLabel(t, q.review_reason)}
            </span>
          )}
        </span>
      </header>
      {editing ? (
        <QuestionForm
          question={q}
          saving={context.saving}
          onCancel={() => {
            setEditing(false);
          }}
          onSave={async (change) => {
            if (await context.save(change)) setEditing(false);
          }}
        />
      ) : (
        <>
          <p>
            <RichText text={q.text} rtlMath={rtl} />
          </p>
          {q.image && <img className="figure" src={q.image.url} alt="" />}
          {q.options.length > 0 && (
            <ul className="options">
              {q.options.map((o) => (
                <li
                  key={o.key}
                  className={q.correct.includes(o.key) ? "correct" : ""}
                >
                  <strong>{o.key}</strong>{" "}
                  <RichText text={o.text} rtlMath={rtl} />
                  {q.correct.includes(o.key) && " ✓"}
                </li>
              ))}
            </ul>
          )}
          {q.options.length === 0 && q.correct.length > 0 && (
            <p className="muted small">
              {t.answer}: {q.correct.join("، ")}
            </p>
          )}
        </>
      )}
      {!editing && (
        <ItemActions
          id={q.id}
          pdfPage={q.image?.pdf_page ?? q.locator.pdf_page}
          context={context}
          extra={
            <>
              <button
                type="button"
                className="secondary small"
                onClick={() => {
                  setEditing(true);
                }}
              >
                {t.edit}
              </button>
              {q.answer_source === "model" && q.review_required && (
                <button
                  type="button"
                  className="small"
                  disabled={context.saving}
                  onClick={() =>
                    void context.save({ op: "accept_answer", id: q.id })
                  }
                >
                  {t.acceptAnswer}
                </button>
              )}
              <PassagePicker question={q} context={context} />
            </>
          }
        />
      )}
    </article>
  );
}

/** Edit a question's text, options and correct answer. */
function QuestionForm(props: {
  question: Question;
  saving: boolean;
  onSave: (change: Change) => Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const q = props.question;
  const [text, setText] = useState(q.text);
  const [options, setOptions] = useState(q.options);
  const [correct, setCorrect] = useState(q.correct);
  const [answer, setAnswer] = useState(q.correct.join("، "));
  const choice = q.type === "multiple_choice";
  return (
    <form
      className="question-form"
      onSubmit={(e) => {
        e.preventDefault();
        void props.onSave({
          op: "edit_question",
          id: q.id,
          text,
          options,
          correct: choice
            ? correct
            : answer
                .split(/[،,]/)
                .map((a) => a.trim())
                .filter((a) => a !== ""),
        });
      }}
    >
      <label>
        {t.questionText}
        <textarea
          dir="auto"
          value={text}
          required
          onChange={(e) => {
            setText(e.target.value);
          }}
        />
      </label>
      {choice &&
        options.map((o, i) => (
          <div key={o.key} className="row option-row">
            <label className="inline">
              <input
                type="checkbox"
                checked={correct.includes(o.key)}
                aria-label={`${t.correctOption} ${o.key}`}
                onChange={(e) => {
                  setCorrect(
                    e.target.checked
                      ? [...correct, o.key]
                      : correct.filter((k) => k !== o.key),
                  );
                }}
              />
              <strong>{o.key}</strong>
            </label>
            <input
              dir="auto"
              aria-label={`${t.option} ${o.key}`}
              value={o.text}
              onChange={(e) => {
                setOptions(
                  options.map((x, j) =>
                    j === i ? { ...x, text: e.target.value } : x,
                  ),
                );
              }}
            />
          </div>
        ))}
      {!choice && (
        <label>
          {t.answer}
          <input
            dir="auto"
            value={answer}
            onChange={(e) => {
              setAnswer(e.target.value);
            }}
          />
        </label>
      )}
      <div className="row">
        <button type="submit" disabled={props.saving}>
          {t.saveFix}
        </button>
        <button type="button" className="secondary" onClick={props.onCancel}>
          {t.cancel}
        </button>
      </div>
    </form>
  );
}

/** Move into or out of a passage (`grouping_uncertain`). */
function PassagePicker(props: { question: Question; context: ItemContext }) {
  const { t } = useI18n();
  const { question: q, context } = props;
  const passages = context.doc.stimuli.filter((s) => s.node_id === q.node_id);
  if (passages.length === 0 && q.stimulus_id === null) return null;
  return (
    <select
      aria-label={t.passage}
      value={q.stimulus_id ?? ""}
      disabled={context.saving}
      onChange={(e) =>
        void context.save({
          op: "set_stimulus",
          id: q.id,
          stimulus_id: e.target.value === "" ? null : e.target.value,
        })
      }
    >
      <option value="">{t.noPassage}</option>
      {passages.map((s, i) => (
        <option key={s.id} value={s.id}>
          {t.passage} {i + 1}
        </option>
      ))}
    </select>
  );
}

/** What every item has: show its page, move it, recrop it, delete it. */
function ItemActions(props: {
  id: string;
  pdfPage: number;
  context: ItemContext;
  extra?: React.ReactNode;
  /** A chunk's "recrop" adds a figure; its figures are recropped one by one. */
  recropLabel?: string;
}) {
  const { t } = useI18n();
  const { context } = props;
  return (
    <div className="row item-actions">
      {props.extra}
      <button
        type="button"
        className="secondary small"
        onClick={() => {
          context.show(props.pdfPage);
        }}
      >
        {t.showPage}
      </button>
      <button
        type="button"
        className="secondary small"
        onClick={() => {
          context.show(props.pdfPage, { id: props.id });
        }}
      >
        {props.recropLabel ?? t.recrop}
      </button>
      <NodeSelect
        label={t.moveTo}
        outline={context.outline}
        disabled={context.saving}
        onPick={(nodeId) =>
          void context.save({ op: "move", id: props.id, node_id: nodeId })
        }
      />
      <button
        type="button"
        className="danger small"
        disabled={context.saving}
        onClick={() => {
          if (confirm(t.confirmDelete))
            void context.save({ op: "delete", id: props.id });
        }}
      >
        {t.delete}
      </button>
    </div>
  );
}

function NodeSelect(props: {
  label: string;
  outline: Outline;
  disabled: boolean;
  onPick: (nodeId: string) => void;
}) {
  const options = useMemo(() => {
    const out: { id: string; name: string }[] = [];
    const visit = (nodes: OutlineNode[], depth: number) => {
      for (const n of nodes) {
        out.push({ id: n.id, name: `${"— ".repeat(depth)}${n.name}` });
        visit(n.children, depth + 1);
      }
    };
    visit(props.outline.nodes, 0);
    return out;
  }, [props.outline]);
  return (
    <select
      aria-label={props.label}
      value=""
      disabled={props.disabled}
      onChange={(e) => {
        if (e.target.value !== "") props.onPick(e.target.value);
      }}
    >
      <option value="">{props.label}</option>
      {options.map((o) => (
        <option key={o.id} value={o.id}>
          {o.name}
        </option>
      ))}
    </select>
  );
}

function ChunkCard(props: { chunk: ExplanationChunk; context: ItemContext }) {
  const { t } = useI18n();
  const { chunk: c, context } = props;
  const [editing, setEditing] = useState(false);
  const [heading, setHeading] = useState(c.heading);
  const [markdown, setMarkdown] = useState(c.markdown);
  return (
    <article
      className={c.review_required ? "item chunk flagged" : "item chunk"}
      data-testid="chunk"
    >
      {c.review_reason && (
        <span className="badge flag">{reasonLabel(t, c.review_reason)}</span>
      )}
      {editing ? (
        <form
          className="question-form"
          onSubmit={(e) => {
            e.preventDefault();
            void context
              .save({ op: "edit_chunk", id: c.id, heading, markdown })
              .then((ok) => {
                if (ok) setEditing(false);
              });
          }}
        >
          <input
            dir="auto"
            aria-label={t.heading}
            value={heading}
            onChange={(e) => {
              setHeading(e.target.value);
            }}
          />
          <textarea
            dir="auto"
            rows={8}
            aria-label={t.explanationText}
            value={markdown}
            onChange={(e) => {
              setMarkdown(e.target.value);
            }}
          />
          <div className="row">
            <button type="submit" disabled={context.saving}>
              {t.saveFix}
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => {
                setEditing(false);
              }}
            >
              {t.cancel}
            </button>
          </div>
        </form>
      ) : (
        <>
          <h3 dir="auto">{c.heading}</h3>
          <RichText
            text={c.markdown}
            rtlMath={c.math_direction === "rtl"}
            block
          />
          {c.figures.map((f, i) => (
            <figure key={i} className="chunk-figure">
              <img className="figure" src={f.url} alt="" />
              <button
                type="button"
                className="secondary small"
                onClick={() => {
                  context.show(f.pdf_page, { id: c.id, figure: i });
                }}
              >
                {t.recrop}
              </button>
            </figure>
          ))}
          <ItemActions
            id={c.id}
            pdfPage={c.pages.pdf[0] ?? 1}
            context={context}
            recropLabel={t.addFigure}
            extra={
              <button
                type="button"
                className="secondary small"
                onClick={() => {
                  setHeading(c.heading);
                  setMarkdown(c.markdown);
                  setEditing(true);
                }}
              >
                {t.edit}
              </button>
            }
          />
        </>
      )}
    </article>
  );
}

/** What wasn't placed: why, on which page, and placing its questions. */
function Unplaced(props: { context: ItemContext }) {
  const { t } = useI18n();
  const { doc } = props.context;
  if (doc.failures.length === 0)
    return <p className="muted">{t.nothingHere}</p>;
  return (
    <>
      {doc.failures.map((f, index) => (
        <FailureCard
          key={`${f.reason}-${String(f.locator.pdf_page)}-${String(index)}`}
          failure={f}
          index={index}
          context={props.context}
        />
      ))}
    </>
  );
}

function FailureCard(props: {
  failure: Failure;
  index: number;
  context: ItemContext;
}) {
  const { t } = useI18n();
  const { failure: f, context } = props;
  const [blocks, setBlocks] = useState<
    { block_id: string; number: string | null; text: string }[] | null
  >(null);
  const page = f.locator.pdf_page;
  // A question already placed from this page isn't offered again.
  const placed = new Set(context.doc.questions.map((q) => q.id));
  const placeable = blocks?.filter(
    (b) => !placed.has(`q_${b.block_id.slice(1).replace("#", "_")}`),
  );
  const load = async () => {
    const list = await api<{ data: NonNullable<typeof blocks> }>(
      "GET",
      `/page/documents/${context.doc.id}/pages/${String(page)}/questions`,
      { orgId: context.orgId },
    );
    setBlocks(list.data);
  };
  return (
    <article className="item flagged" data-testid="failure">
      <header className="row spread">
        <span className="badge flag">{reasonLabel(t, f.reason)}</span>
        <span className="muted small">{fill(t.pdfPageN, { n: page })}</span>
      </header>
      {f.detail && <p className="muted small">{f.detail}</p>}
      <div className="row item-actions">
        <button
          type="button"
          className="secondary small"
          onClick={() => {
            context.show(page);
          }}
        >
          {t.showPage}
        </button>
        <button
          type="button"
          className="secondary small"
          onClick={() => void load()}
        >
          {t.questionsOnPage}
        </button>
        <button
          type="button"
          className="danger small"
          disabled={context.saving}
          onClick={() =>
            void context.save({ op: "dismiss_failure", index: props.index })
          }
        >
          {t.dismiss}
        </button>
      </div>
      {placeable?.length === 0 && (
        <p className="muted small">{t.nothingHere}</p>
      )}
      {placeable?.map((b) => (
        <div key={b.block_id} className="placeable">
          <p dir="auto">
            {b.number && <strong>{b.number}. </strong>}
            <RichText text={b.text} />
          </p>
          <NodeSelect
            label={t.placeUnder}
            outline={context.outline}
            disabled={context.saving}
            onPick={(nodeId) =>
              void context.save({
                op: "place_block",
                pdf_page: page,
                block_id: b.block_id,
                node_id: nodeId,
              })
            }
          />
        </div>
      ))}
    </article>
  );
}

/** The page an item came from; while recropping, a box to drag on it. */
function PagePanel(props: {
  focus: Focus;
  src: string;
  save: (change: Change) => Promise<boolean>;
  saving: boolean;
  onDone: () => void;
}) {
  const { t } = useI18n();
  const [box, setBox] = useState<CropBox | null>(null);
  const { recrop } = props.focus;
  const alt = fill(t.pdfPageN, { n: props.focus.pdfPage });
  if (!recrop)
    return (
      <>
        <h2>{alt}</h2>
        <img className="page-image" src={props.src} alt={alt} />
      </>
    );
  return (
    <>
      <h2>{t.recrop}</h2>
      <p className="muted small">{t.recropHelp}</p>
      <CropEditor src={props.src} alt={alt} box={box} onChange={setBox} />
      <div className="row">
        <button
          type="button"
          disabled={
            props.saving || !box || box.w < MIN_CROP || box.h < MIN_CROP
          }
          onClick={() => {
            if (!box) return;
            void props
              .save({
                op: "recrop",
                id: recrop.id,
                box,
                ...(recrop.figure === undefined
                  ? {}
                  : { figure: recrop.figure }),
              })
              .then((ok) => {
                if (ok) props.onDone();
              });
          }}
        >
          {t.saveCrop}
        </button>
        <button type="button" className="secondary" onClick={props.onDone}>
          {t.cancel}
        </button>
      </div>
    </>
  );
}
