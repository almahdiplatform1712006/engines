// Step 4 of the flow (spec §1): upload the book, see what it will cost, start.
// A book whose contents pages drafted the tree was uploaded already.
import { useEffect, useState } from "react";
import { api } from "../api.ts";
import { plain } from "../errors.ts";
import {
  FileList,
  FilePicker,
  PHOTO_TYPES,
  UploadProgressBar,
  useUploads,
} from "../files.tsx";
import { fill, useI18n } from "../i18n.tsx";
import { navigate, query } from "../router.tsx";
import type { BookType } from "./NewBook.tsx";
import type { Organisation } from "./OrganisationShell.tsx";

interface Estimate {
  pages: number;
  balance: number;
  warning: { message: string; document_id: string | null } | null;
}

type Source = { upload_id: string } | { upload_ids: string[] };

export function UploadBook(props: {
  organisation: Organisation;
  outlineId: string;
}) {
  const { t, number } = useI18n();
  const orgId = props.organisation.id;
  const type = (query("type") ?? "questions") as BookType;
  const book = query("book");
  const [photos, setPhotos] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const { progress, uploadAll } = useUploads(orgId);
  const [source, setSource] = useState<Source | null>(
    book ? { upload_id: book } : null,
  );
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  // Once the book is in storage: how many pages, and what they cost. A book
  // that's refused goes back to choosing a file.
  useEffect(() => {
    if (!source) return;
    api<Estimate>("POST", "/page/estimate", { orgId, body: { source } })
      .then(setEstimate)
      .catch((e: unknown) => {
        setError(e);
        setSource(null);
      });
  }, [source, orgId]);

  async function upload() {
    setBusy(true);
    setError(null);
    try {
      const ids = await uploadAll(files);
      setSource(photos ? { upload_ids: ids } : { upload_id: ids[0] ?? "" });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  async function start() {
    if (!source) return;
    setBusy(true);
    setError(null);
    try {
      const created = await api<{ id: string }>("POST", "/v1/documents", {
        orgId,
        body: { outline_id: props.outlineId, type, source },
      });
      navigate(`/o/${orgId}/documents/${created.id}`);
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  }

  const choose = (asPhotos: boolean) => {
    setPhotos(asPhotos);
    setFiles([]);
  };

  return (
    <section className="card">
      <h1>{t.uploadBook}</h1>
      {!source && (
        <>
          <div className="row">
            <label className="choice">
              <input
                type="radio"
                name="kind"
                checked={!photos}
                onChange={() => {
                  choose(false);
                }}
              />
              {t.bookPdf}
            </label>
            <label className="choice">
              <input
                type="radio"
                name="kind"
                checked={photos}
                onChange={() => {
                  choose(true);
                }}
              />
              {t.bookPhotos}
            </label>
          </div>
          <FilePicker
            multiple={photos}
            accept={photos ? PHOTO_TYPES : "application/pdf"}
            label={photos ? t.choosePhotos : t.chooseFile}
            onFiles={(picked) => {
              setFiles(photos ? [...files, ...picked] : picked.slice(0, 1));
            }}
          />
          <FileList files={files} reorder={photos} onChange={setFiles} />
          {busy && <UploadProgressBar progress={progress} />}
          <button
            type="button"
            disabled={files.length === 0 || busy}
            onClick={() => void upload()}
          >
            {t.upload}
          </button>
        </>
      )}
      {source && !estimate && <p className="muted">{t.loading}</p>}
      {estimate && (
        <div className="estimate" data-testid="estimate">
          <p>
            {fill(t.estimate, {
              pages: number(estimate.pages),
              balance: number(estimate.balance),
            })}
          </p>
          {estimate.warning && (
            <p className="warning" role="status">
              {estimate.warning.message} {t.runAgain}
            </p>
          )}
          <button type="button" disabled={busy} onClick={() => void start()}>
            {t.startProcessing}
          </button>
        </div>
      )}
      {error !== null && (
        <p className="error" role="alert">
          {plain(error, t)}
        </p>
      )}
    </section>
  );
}
