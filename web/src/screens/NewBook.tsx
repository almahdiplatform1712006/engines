// Steps 1–2 of the flow (spec §1): what the book is for, then where its
// syllabus is. A syllabus is uploaded and drafted into a tree; typing it in
// starts the tree with one node.
import { useState } from "react";
import { api } from "../api.ts";
import { useI18n } from "../i18n.tsx";
import { NumberInput } from "../NumberInput.tsx";
import { navigate } from "../router.tsx";
import { uploadFile, type UploadProgress } from "../upload.ts";
import type { Organisation } from "./OrganisationShell.tsx";

export type BookType = "questions" | "explanation" | "both";
type SyllabusKind = "pdf" | "images" | "book_pages" | "manual";

const PHOTO_TYPES = "image/jpeg,image/png,image/webp";

export function NewBook({ organisation }: { organisation: Organisation }) {
  const { t, number } = useI18n();
  const entitled = organisation.entitlements.includes("explanation");
  const types: BookType[] = entitled
    ? ["questions", "explanation", "both"]
    : ["questions"];
  const [type, setType] = useState<BookType>("questions");
  const [kind, setKind] = useState<SyllabusKind>("pdf");
  const [files, setFiles] = useState<File[]>([]);
  const [range, setRange] = useState<{
    from: number | null;
    to: number | null;
  }>({ from: null, to: null });
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const ready =
    kind === "manual" ||
    (files.length > 0 &&
      (kind !== "book_pages" ||
        (range.from !== null && range.to !== null && range.from <= range.to)));

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const orgId = organisation.id;
      const ids: string[] = [];
      const total = files.reduce((sum, f) => sum + f.size, 0);
      let before = 0;
      for (const file of kind === "manual" ? [] : files) {
        ids.push(
          await uploadFile(file, orgId, (p) => {
            setProgress({ sent: before + p.sent, total });
          }),
        );
        before += file.size;
      }
      const source =
        kind === "manual"
          ? { type: "manual", nodes: [{ name: t.firstNode }] }
          : kind === "images"
            ? { type: "images", upload_ids: ids }
            : kind === "pdf"
              ? { type: "pdf", upload_id: ids[0] }
              : {
                  type: "book_pages",
                  upload_id: ids[0],
                  from: range.from,
                  to: range.to,
                };
      const outline = await api<{ id: string }>("POST", "/v1/outlines", {
        orgId,
        body: { source },
      });
      // The book itself, when it was uploaded here, is reused in step 4.
      const book = kind === "book_pages" ? `&book=${ids[0] ?? ""}` : "";
      navigate(`/o/${orgId}/outlines/${outline.id}?type=${type}${book}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : t.error);
      setBusy(false);
    }
  }

  const move = (i: number, by: number) => {
    const next = [...files];
    const [file] = next.splice(i, 1);
    if (file) next.splice(i + by, 0, file);
    setFiles(next);
  };

  return (
    <section className="card">
      <h1>{t.newBook}</h1>
      <fieldset>
        <legend>{t.stepType}</legend>
        {types.map((option) => (
          <label key={option} className="choice">
            <input
              type="radio"
              name="type"
              checked={type === option}
              onChange={() => {
                setType(option);
              }}
            />
            {t.types[option]}
          </label>
        ))}
        {!entitled && <p className="muted small">{t.explanationLocked}</p>}
      </fieldset>

      <fieldset>
        <legend>{t.stepSyllabus}</legend>
        {(["pdf", "images", "book_pages", "manual"] as const).map((option) => (
          <label key={option} className="choice">
            <input
              type="radio"
              name="syllabus"
              checked={kind === option}
              onChange={() => {
                setKind(option);
                setFiles([]);
              }}
            />
            <span>
              {t.syllabusSources[option]}
              <span className="muted small block">
                {t.syllabusHints[option]}
              </span>
            </span>
          </label>
        ))}
      </fieldset>

      {kind !== "manual" && (
        <FilePicker
          multiple={kind === "images"}
          accept={kind === "images" ? PHOTO_TYPES : "application/pdf"}
          label={kind === "images" ? t.choosePhotos : t.chooseFile}
          onFiles={(picked) => {
            setFiles(
              kind === "images" ? [...files, ...picked] : picked.slice(0, 1),
            );
          }}
        />
      )}
      {files.length > 0 && (
        <ol className="list files">
          {files.map((file, i) => (
            <li key={`${file.name}-${String(i)}`}>
              <span dir="auto">{file.name}</span>
              {kind === "images" && (
                <span className="row">
                  <button
                    type="button"
                    className="secondary"
                    disabled={i === 0}
                    aria-label={t.moveUp}
                    onClick={() => {
                      move(i, -1);
                    }}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    disabled={i === files.length - 1}
                    aria-label={t.moveDown}
                    onClick={() => {
                      move(i, 1);
                    }}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    className="danger"
                    onClick={() => {
                      setFiles(files.filter((_, j) => j !== i));
                    }}
                  >
                    {t.remove}
                  </button>
                </span>
              )}
            </li>
          ))}
        </ol>
      )}
      {kind === "book_pages" && (
        <div className="row">
          <label className="inline">
            {t.contentsFrom}
            <NumberInput
              label={t.contentsFrom}
              value={range.from}
              onChange={(from) => {
                setRange({ ...range, from });
              }}
            />
          </label>
          <label className="inline">
            {t.contentsTo}
            <NumberInput
              label={t.contentsTo}
              value={range.to}
              onChange={(to) => {
                setRange({ ...range, to });
              }}
            />
          </label>
        </div>
      )}

      {progress && busy && (
        <div className="progress-line" role="status">
          <progress value={progress.sent} max={progress.total} />
          <span className="muted small">
            {t.uploading}{" "}
            {number(
              Math.floor((100 * progress.sent) / Math.max(progress.total, 1)),
            )}
            %
          </span>
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <button
        type="button"
        disabled={!ready || busy}
        onClick={() => void start()}
      >
        {t.start}
      </button>
    </section>
  );
}

/** A file input that also takes files dropped on it. */
export function FilePicker(props: {
  multiple: boolean;
  accept: string;
  label: string;
  onFiles: (files: File[]) => void;
}) {
  const { t } = useI18n();
  const [over, setOver] = useState(false);
  return (
    <label
      className={over ? "dropzone over" : "dropzone"}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => {
        setOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        props.onFiles([...e.dataTransfer.files]);
      }}
    >
      <span className="button-like">{props.label}</span>
      <span className="muted small">{t.dropHere}</span>
      <input
        type="file"
        className="visually-hidden"
        multiple={props.multiple}
        accept={props.accept}
        onChange={(e) => {
          props.onFiles([...(e.target.files ?? [])]);
          e.target.value = "";
        }}
      />
    </label>
  );
}
