// Steps 1–2 of the flow (spec §1): what the book is for, then where its
// syllabus is. A syllabus is uploaded and drafted into a tree; typing it in
// starts the tree with one node.
import { useState } from "react";
import { api } from "../api.ts";
import { useI18n } from "../i18n.tsx";
import { NumberInput } from "../NumberInput.tsx";
import { plain } from "../errors.ts";
import {
  FileList,
  FilePicker,
  PHOTO_TYPES,
  UploadProgressBar,
  useUploads,
} from "../files.tsx";
import { navigate } from "../router.tsx";
import type { Organisation } from "./OrganisationShell.tsx";

export type BookType = "questions" | "explanation" | "both";
type SyllabusKind = "pdf" | "images" | "book_pages" | "manual";

export function NewBook({ organisation }: { organisation: Organisation }) {
  const { t } = useI18n();
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
  const { progress, uploadAll } = useUploads(organisation.id);
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
      const ids = kind === "manual" ? [] : await uploadAll(files);
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
      setError(plain(e, t));
      setBusy(false);
    }
  }

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
      <FileList files={files} reorder={kind === "images"} onChange={setFiles} />
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

      {busy && <UploadProgressBar progress={progress} />}
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
