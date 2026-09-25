// The organisation's books: every document, newest first, with its status.
import { useEffect, useState } from "react";
import { TERMINAL_STATUSES } from "../../../src/contract/document.ts";
import { api } from "../api.ts";
import { fill, statusLabel, useI18n } from "../i18n.tsx";
import { Link } from "../router.tsx";
import type { Organisation } from "./OrganisationShell.tsx";

const POLL_MS = 5000;
const TERMINAL = new Set<string>(TERMINAL_STATUSES);

interface Row {
  id: string;
  title: string;
  type: "questions" | "explanation" | "both";
  status: string;
  pages: number | null;
  pages_read: number;
  created_at: string;
}

export function Books({ organisation }: { organisation: Organisation }) {
  const { t, date, number } = useI18n();
  const orgId = organisation.id;
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Refreshes while any book is still running.
  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const list = await api<{ data: Row[] }>("GET", "/page/documents", {
          orgId,
        });
        if (stop) return;
        setRows(list.data);
        setError(null);
        if (list.data.some((row) => !TERMINAL.has(row.status)))
          timer = setTimeout(() => void load(), POLL_MS);
      } catch (e) {
        if (!stop) setError(e instanceof Error ? e.message : String(e));
      }
    };
    void load();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [orgId]);

  return (
    <section className="card">
      <div className="row spread">
        <h1>{t.books}</h1>
        <Link className="button-like" to={`/o/${orgId}/new`}>
          {t.newBook}
        </Link>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {rows === null ? (
        !error && <p className="muted">{t.loading}</p>
      ) : rows.length === 0 ? (
        <p className="muted">{t.noBooks}</p>
      ) : (
        <ul className="list">
          {rows.map((row) => (
            <li key={row.id}>
              <div>
                <Link to={`/o/${orgId}/documents/${row.id}`}>
                  <strong dir="auto">{row.title}</strong>
                </Link>
                <div className="muted small">
                  {t.types[row.type]} · {date(row.created_at)}
                  {row.pages !== null &&
                    ` · ${fill(t.pagesRead, {
                      read: number(row.pages_read),
                      total: number(row.pages),
                    })}`}
                </div>
              </div>
              <span className="badge">{statusLabel(t, row.status)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
