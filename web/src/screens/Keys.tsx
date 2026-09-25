import { useCallback, useEffect, useState } from "react";
import { api } from "../api.ts";
import { field } from "../forms.ts";
import { useI18n } from "../i18n.tsx";
import { canManage, type Organisation } from "./OrganisationShell.tsx";

interface Key {
  id: string;
  name: string;
  prefix: string;
  created_at: string;
  revoked_at: string | null;
}

export function Keys({ organisation }: { organisation: Organisation }) {
  const { t, date } = useI18n();
  const [keys, setKeys] = useState<Key[] | null>(null);
  const [fresh, setFresh] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const orgId = organisation.id;
  const manage = canManage(organisation);

  const load = useCallback(async () => {
    const list = await api<{ data: Key[] }>("GET", "/page/keys", { orgId });
    setKeys(list.data);
  }, [orgId]);
  useEffect(() => {
    void load().catch((e: unknown) => {
      setError(e instanceof Error ? e.message : t.error);
    });
  }, [load, t.error]);

  async function create(name: string) {
    setError(null);
    try {
      const created = await api<{ key: string }>("POST", "/page/keys", {
        orgId,
        body: { name },
      });
      setFresh(created.key);
      setCopied(false);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : t.error);
    }
  }

  async function revoke(id: string) {
    if (!confirm(t.confirmRevoke)) return;
    setError(null);
    try {
      await api("DELETE", `/page/keys/${id}`, { orgId });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : t.error);
    }
  }

  return (
    <section className="card">
      <h1>{t.keys}</h1>
      {fresh && (
        <div className="notice" role="status">
          <p>{t.keyShownOnce}</p>
          <code dir="ltr" className="secret" data-testid="new-key">
            {fresh}
          </code>
          <div className="row">
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard.writeText(fresh).then(() => {
                  setCopied(true);
                });
              }}
            >
              {copied ? t.copied : t.copy}
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => {
                setFresh(null);
              }}
            >
              {t.done}
            </button>
          </div>
        </div>
      )}
      {manage ? (
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            const form = e.currentTarget;
            void create(field(form, "name")).then(() => {
              form.reset();
            });
          }}
        >
          <input
            name="name"
            aria-label={t.keyName}
            placeholder={t.keyName}
            required
            maxLength={100}
          />
          <button type="submit">{t.createKey}</button>
        </form>
      ) : (
        <p className="muted">{t.onlyAdmins}</p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {keys === null ? (
        <p className="muted">{t.loading}</p>
      ) : keys.length === 0 ? (
        <p className="muted">{t.noKeys}</p>
      ) : (
        <ul className="list">
          {keys.map((k) => (
            <li key={k.id} className={k.revoked_at ? "revoked" : ""}>
              <div>
                <strong>{k.name}</strong> <code dir="ltr">{k.prefix}…</code>
                <div className="muted small">
                  {t.created} {date(k.created_at)}
                  {k.revoked_at && ` · ${t.revoked} ${date(k.revoked_at)}`}
                </div>
              </div>
              {manage && !k.revoked_at && (
                <button
                  type="button"
                  className="danger"
                  onClick={() => void revoke(k.id)}
                >
                  {t.revoke}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
