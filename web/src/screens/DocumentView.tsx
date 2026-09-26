// Steps 5–6 of the flow (spec §1): confirm where printed page numbers start,
// then watch the book being read. Polls the document; nothing here needs the
// page to stay open.
import { useEffect, useState } from "react";
import type { Document } from "../../../src/contract/document.ts";
import { api } from "../api.ts";
import { TERMINAL } from "../status.ts";
import { fill, statusLabel, useI18n } from "../i18n.tsx";
import { NumberInput } from "../NumberInput.tsx";
import { Link } from "../router.tsx";
import type { Organisation } from "./OrganisationShell.tsx";
import { permanent, plain } from "../errors.ts";

const POLL_MS = 2000;
const EXPORTS = ["xlsx", "docx", "pdf", "json"] as const;

export function DocumentView(props: {
  organisation: Organisation;
  documentId: string;
}) {
  const { t, number } = useI18n();
  const orgId = props.organisation.id;
  const path = `/v1/documents/${props.documentId}`;
  const [doc, setDoc] = useState<Document | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const next = await api<Document>("GET", path, { orgId });
        if (stop) return;
        setDoc(next);
        setError(null);
        // Waiting on a person needs no polling until they act.
        if (!TERMINAL.has(next.status) && next.status !== "awaiting_offset")
          timer = setTimeout(() => void load(), POLL_MS);
      } catch (e) {
        if (stop) return;
        setError(plain(e, t));
        // Not found, gone or not allowed won't change by asking again.
        if (!permanent(e)) timer = setTimeout(() => void load(), POLL_MS * 2);
      }
    };
    void load();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
    // The language only changes how an error reads, not what's loaded.
  }, [path, orgId, tick]);

  if (!doc)
    return error ? (
      <p className="error" role="alert">
        {error}
      </p>
    ) : (
      <p className="muted">{t.loading}</p>
    );

  const { pages_read, pages_total } = doc.progress;
  return (
    <section className="card">
      <h1>{t.bookStatus}</h1>
      <p>
        <span className="badge" data-testid="status">
          {statusLabel(t, doc.status)}
        </span>
      </p>
      {doc.warning && <p className="warning">{doc.warning.message}</p>}

      {doc.status === "awaiting_offset" && (
        <OffsetConfirm
          key={JSON.stringify(doc.offset)}
          doc={doc}
          orgId={orgId}
          onConfirmed={() => {
            setTick((n) => n + 1);
          }}
        />
      )}

      {!TERMINAL.has(doc.status) && doc.status !== "awaiting_offset" && (
        <div role="status">
          {pages_total !== null && doc.status === "processing" && (
            <>
              <progress value={pages_read} max={pages_total} />
              <p data-testid="progress">
                {fill(t.pagesRead, {
                  read: number(pages_read),
                  total: number(pages_total),
                })}
              </p>
            </>
          )}
          <p className="muted">{t.canClose}</p>
        </div>
      )}

      {TERMINAL.has(doc.status) && (
        <>
          {doc.status === "failed" ? (
            <p className="error">{doc.error ?? t.error}</p>
          ) : (
            <ul className="summary">
              <li>
                {fill(t.questionsFound, { n: number(doc.questions.length) })}
              </li>
              {doc.explanation && (
                <li>
                  {fill(t.chunksFound, { n: number(doc.explanation.length) })}
                </li>
              )}
              {doc.failures.length > 0 && (
                <li className="warning">
                  {fill(t.failuresFound, { n: number(doc.failures.length) })}
                </li>
              )}
            </ul>
          )}
          {doc.status !== "failed" && (
            <div className="row">
              <Link className="button-like" to={`/o/${orgId}/review/${doc.id}`}>
                {t.openResults}
              </Link>
              {EXPORTS.map((format) => (
                <a
                  key={format}
                  className="secondary-link"
                  href={`${path}/export?format=${format}&org=${encodeURIComponent(orgId)}`}
                  download
                >
                  {t.download} {format.toUpperCase()}
                </a>
              ))}
            </div>
          )}
        </>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

/**
 * The proposed offset, one segment at a time: "printed 7 = PDF 11", with two
 * of the segment's own pages to check the printed number on.
 */
function OffsetConfirm(props: {
  doc: Document;
  orgId: string;
  onConfirmed: () => void;
}) {
  const { t, number } = useI18n();
  const { doc, orgId } = props;
  const [segments, setSegments] = useState<
    { printed_from: number | null; pdf_from: number | null }[]
  >(
    // No numbers found (a scan, or the quick pass failed): one segment for
    // the person to fill in.
    doc.offset.length === 0
      ? [{ printed_from: null, pdf_from: null }]
      : doc.offset.map((s) => ({
          printed_from: s.printed_from,
          pdf_from: s.pdf_from,
        })),
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pageCount = doc.progress.pages_total ?? 1;

  const complete = segments.every(
    (s) => s.printed_from !== null && s.pdf_from !== null,
  );

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await api("POST", `/v1/documents/${doc.id}/offset`, {
        orgId,
        body: { segments },
      });
      props.onConfirmed();
    } catch (e) {
      setError(plain(e, t));
      setBusy(false);
      // Someone else may have confirmed it already: look again.
      if (permanent(e)) props.onConfirmed();
    }
  }

  const image = (pdfPage: number) =>
    `/page/documents/${doc.id}/pages/${String(pdfPage)}?org=${encodeURIComponent(orgId)}`;

  return (
    <div className="offset">
      <h2>{t.offsetTitle}</h2>
      <p className="muted">
        {doc.offset.length === 0 ? t.offsetNoneFound : t.offsetHelp}
      </p>
      {segments.map((segment, i) => {
        const pdf = Math.min(Math.max(segment.pdf_from ?? 1, 1), pageCount);
        const samples = [pdf, Math.min(pdf + 1, pageCount)].filter(
          (p, j, all) => all.indexOf(p) === j,
        );
        return (
          <div key={i} className="segment" data-testid="segment">
            <p className="row">
              <label className="inline">
                {t.printedPage}
                <NumberInput
                  label={t.printedPage}
                  value={segment.printed_from}
                  onChange={(printed_from) => {
                    setSegments(
                      segments.map((s, j) =>
                        j === i ? { ...s, printed_from } : s,
                      ),
                    );
                  }}
                />
              </label>
              <span aria-hidden="true">=</span>
              <label className="inline">
                {t.pdfPage}
                <NumberInput
                  label={t.pdfPage}
                  value={segment.pdf_from}
                  onChange={(pdf_from) => {
                    setSegments(
                      segments.map((s, j) =>
                        j === i ? { ...s, pdf_from } : s,
                      ),
                    );
                  }}
                />
              </label>
            </p>
            <div className="thumbs">
              {samples.map((p) => (
                <figure key={p}>
                  <img
                    src={image(p)}
                    loading="lazy"
                    alt={fill(t.pdfPageN, { n: number(p) })}
                  />
                  <figcaption className="muted small">
                    {fill(t.pdfPageN, { n: number(p) })}
                  </figcaption>
                </figure>
              ))}
            </div>
          </div>
        );
      })}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <button
        type="button"
        disabled={!complete || busy}
        onClick={() => void confirm()}
      >
        {t.confirmOffset}
      </button>
    </div>
  );
}
