// What choosing and uploading a book's files share, in the new-book and
// upload screens: a picker that takes drops, the photo list in page order,
// and uploading several files as one progress bar.
import { useRef, useState } from "react";
import { useI18n } from "./i18n.tsx";
import { uploadFile, type UploadProgress } from "./upload.ts";

export const PHOTO_TYPES = "image/jpeg,image/png,image/webp";

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

/** The chosen files; photos, one page each, can be put in order. */
export function FileList(props: {
  files: File[];
  reorder: boolean;
  onChange: (files: File[]) => void;
}) {
  const { t } = useI18n();
  const { files } = props;
  if (files.length === 0) return null;
  const move = (i: number, by: number) => {
    const next = [...files];
    const [file] = next.splice(i, 1);
    if (file) next.splice(i + by, 0, file);
    props.onChange(next);
  };
  return (
    <ol className="list files">
      {files.map((file, i) => (
        <li key={`${file.name}-${String(i)}`}>
          <span dir="auto">{file.name}</span>
          {props.reorder && (
            <span className="row">
              <button
                type="button"
                className="secondary small"
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
                className="secondary small"
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
                className="danger small"
                onClick={() => {
                  props.onChange(files.filter((_, j) => j !== i));
                }}
              >
                {t.remove}
              </button>
            </span>
          )}
        </li>
      ))}
    </ol>
  );
}

/**
 * Uploads files in order and returns their upload ids. Files already
 * uploaded by an earlier try aren't sent again.
 */
export function useUploads(orgId: string) {
  const done = useRef(new Map<File, string>());
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const uploadAll = async (files: readonly File[]): Promise<string[]> => {
    const total = files.reduce((sum, f) => sum + f.size, 0);
    let before = 0;
    const ids: string[] = [];
    for (const file of files) {
      let id = done.current.get(file);
      if (id === undefined) {
        const offset = before;
        id = await uploadFile(file, orgId, (p) => {
          setProgress({ sent: offset + p.sent, total });
        });
        done.current.set(file, id);
      }
      ids.push(id);
      before += file.size;
      setProgress({ sent: before, total });
    }
    return ids;
  };
  return { progress, uploadAll };
}

export function UploadProgressBar(props: { progress: UploadProgress | null }) {
  const { t, number } = useI18n();
  const { progress } = props;
  if (!progress) return null;
  return (
    <div className="progress-line" role="status">
      <progress value={progress.sent} max={progress.total} />
      <span className="muted small" data-testid="upload-progress">
        {t.uploading}{" "}
        {number(
          Math.floor((100 * progress.sent) / Math.max(progress.total, 1)),
        )}
        %
      </span>
    </div>
  );
}
