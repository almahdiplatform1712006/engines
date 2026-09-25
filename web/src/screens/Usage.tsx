import { useEffect, useState } from "react";
import { api } from "../api.ts";
import { useI18n } from "../i18n.tsx";
import type { Organisation } from "./OrganisationShell.tsx";

interface Entry {
  kind: "grant" | "hold" | "release" | "usage";
  pages: number;
  document_id: string | null;
  note: string | null;
  created_at: string;
}

export function Usage({ organisation }: { organisation: Organisation }) {
  const { t, number, date } = useI18n();
  const [usage, setUsage] = useState<{
    balance: number;
    ledger: Entry[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const orgId = organisation.id;
  useEffect(() => {
    api<{ balance: number; ledger: Entry[] }>("GET", "/v1/usage", { orgId })
      .then(setUsage)
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
      });
  }, [orgId]);

  if (error)
    return (
      <p className="error" role="alert">
        {t.error}: {error}
      </p>
    );
  if (!usage) return <p className="muted">{t.loading}</p>;
  return (
    <section className="card">
      <h1>{t.usage}</h1>
      <p className="balance">
        {t.balance}:{" "}
        <strong data-testid="balance">{number(usage.balance)}</strong>{" "}
        {t.pageCredits}
      </p>
      <h2>{t.ledger}</h2>
      {usage.ledger.length === 0 ? (
        <p className="muted">{t.nothingYet}</p>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>{t.date}</th>
                <th>{t.kind}</th>
                <th>{t.pages}</th>
                <th>{t.note}</th>
              </tr>
            </thead>
            <tbody>
              {usage.ledger.map((e, i) => (
                <tr key={`${e.created_at}-${String(i)}`}>
                  <td>{date(e.created_at)}</td>
                  <td>{t.kinds[e.kind]}</td>
                  <td className="num">{number(e.pages)}</td>
                  <td>
                    {e.note ??
                      (e.document_id && <code dir="ltr">{e.document_id}</code>)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
