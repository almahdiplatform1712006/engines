// The owner's back office (E-20): organisations and their credits,
// entitlements and keys; jobs everywhere with their model cost per page; and
// the audit log. The server checks the super-admin flag on every call.
import { useCallback, useEffect, useState } from "react";
import { api } from "../api.ts";
import { plain } from "../errors.ts";
import { field } from "../forms.ts";
import { fill, statusLabel, useI18n } from "../i18n.tsx";
import { NumberInput } from "../NumberInput.tsx";
import { navigate } from "../router.tsx";

const TABS = ["organisations", "jobs", "audit"] as const;
type Tab = (typeof TABS)[number];

export function Admin(props: { tab: string; id: string | undefined }) {
  const { t } = useI18n();
  const tab: Tab = (TABS as readonly string[]).includes(props.tab)
    ? (props.tab as Tab)
    : "organisations";
  const labels: Record<Tab, string> = {
    organisations: t.organisations,
    jobs: t.jobs,
    audit: t.auditLog,
  };
  return (
    <div className="shell">
      <nav className="tabs" aria-label={t.backOffice}>
        {TABS.map((s) => (
          <a
            key={s}
            href={`/admin/${s}`}
            className={tab === s ? "tab active" : "tab"}
            onClick={(e) => {
              e.preventDefault();
              navigate(`/admin/${s}`);
            }}
          >
            {labels[s]}
          </a>
        ))}
      </nav>
      {tab === "jobs" ? (
        <Jobs />
      ) : tab === "audit" ? (
        <Audit />
      ) : props.id ? (
        <OrganisationDetail key={props.id} id={props.id} />
      ) : (
        <Organisations />
      )}
    </div>
  );
}

interface OrgRow {
  id: string;
  name: string;
  balance: number;
  members: number;
  documents: number;
}

function Organisations() {
  const { t, number } = useI18n();
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<OrgRow[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    const timer = setTimeout(() => {
      api<{ data: OrgRow[] }>(
        "GET",
        `/page/admin/organisations?q=${encodeURIComponent(q)}`,
      )
        .then((list) => {
          setRows(list.data);
          setError(null);
        })
        .catch(setError);
    }, 250);
    return () => {
      clearTimeout(timer);
    };
  }, [q]);
  return (
    <section className="card">
      <h1>{t.organisations}</h1>
      <input
        type="search"
        aria-label={t.search}
        placeholder={t.search}
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
        }}
      />
      {error !== null && <p className="error">{plain(error, t)}</p>}
      <ul className="list">
        {rows?.map((o) => (
          <li key={o.id}>
            <a
              href={`/admin/organisations/${o.id}`}
              onClick={(e) => {
                e.preventDefault();
                navigate(`/admin/organisations/${o.id}`);
              }}
            >
              <strong dir="auto">{o.name}</strong>
            </a>
            <span className="muted small">
              {fill(t.orgSummary, {
                balance: number(o.balance),
                members: number(o.members),
                documents: number(o.documents),
              })}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

interface OrgDetail {
  id: string;
  name: string;
  balance: number;
  entitlements: string[];
  members: { name: string; email: string; role: string }[];
  keys: {
    id: string;
    name: string;
    prefix: string;
    provider: string;
    concurrency: number;
    max_queued: number;
    built_in: boolean;
    revoked_at: string | null;
  }[];
  ledger: {
    kind: string;
    pages: number;
    note: string | null;
    created_at: string;
  }[];
}

function OrganisationDetail(props: { id: string }) {
  const { t, number, date } = useI18n();
  const [org, setOrg] = useState<OrgDetail | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [pages, setPages] = useState<number | null>(null);
  const load = useCallback(async () => {
    try {
      setOrg(
        await api<OrgDetail>("GET", `/page/admin/organisations/${props.id}`),
      );
    } catch (e) {
      setError(e);
    }
  }, [props.id]);
  useEffect(() => {
    void load();
  }, [load]);

  const [busy, setBusy] = useState(false);
  // Every change reloads the organisation, refused or not, so the screen
  // shows what the server has.
  const act = async (method: string, path: string, body?: unknown) => {
    setError(null);
    setBusy(true);
    try {
      await api(method, path, { body });
    } catch (e) {
      setError(e);
    } finally {
      await load();
      setBusy(false);
    }
  };

  if (!org)
    return error !== null ? (
      <p className="error">{plain(error, t)}</p>
    ) : (
      <p className="muted">{t.loading}</p>
    );
  const base = `/page/admin/organisations/${org.id}`;
  return (
    <section className="card">
      <h1 dir="auto">{org.name}</h1>
      <p className="muted small" dir="ltr">
        {org.id}
      </p>
      {error !== null && (
        <p className="error" role="alert">
          {plain(error, t)}
        </p>
      )}

      <h2>{t.balance}</h2>
      <p data-testid="admin-balance">
        {number(org.balance)} {t.pageCredits}
      </p>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          const form = e.currentTarget;
          const note = field(form, "note");
          if (pages !== null)
            void act("POST", `${base}/credits`, { pages, note }).then(() => {
              form.reset();
              setPages(null);
            });
        }}
      >
        <NumberInput label={t.pages} value={pages} onChange={setPages} />
        <input name="note" aria-label={t.note} placeholder={t.note} required />
        <button type="submit" disabled={pages === null || busy}>
          {t.grantCredits}
        </button>
      </form>

      <h2>{t.entitlements}</h2>
      <label className="choice">
        <input
          type="checkbox"
          checked={org.entitlements.includes("explanation")}
          onChange={(e) => {
            const enabled = e.target.checked;
            // Shown at once; the reload after saving confirms it.
            setOrg({
              ...org,
              entitlements: enabled
                ? [...org.entitlements, "explanation"]
                : org.entitlements.filter((x) => x !== "explanation"),
            });
            void act("PUT", `${base}/entitlements/explanation`, { enabled });
          }}
        />
        {t.types.explanation}
      </label>

      <h2>{t.keys}</h2>
      <ul className="list">
        {org.keys.map((k) => (
          <li key={k.id} className={k.revoked_at ? "revoked" : ""}>
            <div>
              <strong>{k.built_in ? t.pageKey : k.name}</strong>{" "}
              <code dir="ltr">{k.prefix}…</code>
            </div>
            <span className="row">
              <ConcurrencyField
                label={`${t.concurrency} (${k.name})`}
                value={k.concurrency}
                onSave={(concurrency) =>
                  act("PATCH", `/page/admin/keys/${k.id}`, { concurrency })
                }
              />
              <select
                aria-label={`${t.provider} (${k.name})`}
                value={k.provider}
                onChange={(e) =>
                  void act("PATCH", `/page/admin/keys/${k.id}`, {
                    provider: e.target.value,
                  })
                }
              >
                <option value="openrouter">OpenRouter</option>
                <option value="vertex">Vertex</option>
              </select>
              {!k.built_in && !k.revoked_at && (
                <button
                  type="button"
                  className="danger small"
                  onClick={() => {
                    if (confirm(t.confirmRevoke))
                      void act("POST", `/page/admin/keys/${k.id}/revoke`);
                  }}
                >
                  {t.revoke}
                </button>
              )}
            </span>
          </li>
        ))}
      </ul>

      <h2>{t.members}</h2>
      <ul className="list">
        {org.members.map((m) => (
          <li key={m.email}>
            <span dir="auto">{m.name}</span>
            <span className="muted small" dir="ltr">
              {m.email}
            </span>
          </li>
        ))}
      </ul>

      <h2>{t.ledger}</h2>
      <div className="table-scroll">
        <table>
          <tbody>
            {org.ledger.map((e, i) => (
              <tr key={i}>
                <td>{date(e.created_at)}</td>
                <td>{e.kind}</td>
                <td className="num">{number(e.pages)}</td>
                <td>{e.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

interface Job {
  id: string;
  org_name: string;
  status: string;
  page_count: number | null;
  failures: Record<string, number>;
  cost_per_page: number | null;
  created_at: string;
}

function Jobs() {
  const { t, number, date } = useI18n();
  const [status, setStatus] = useState("");
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [detail, setDetail] = useState<{
    failures: {
      reason: string;
      detail: string | null;
      locator: { pdf_page: number };
    }[];
    calls: {
      purpose: string;
      model: string;
      calls: number;
      failed: number;
      cost_usd: number;
    }[];
  } | null>(null);
  const [error, setError] = useState<unknown>(null);
  // A response for an older filter or row is ignored when it lands late.
  useEffect(() => {
    let current = true;
    api<{ data: Job[] }>(
      "GET",
      `/page/admin/documents?status=${encodeURIComponent(status)}`,
    )
      .then((list) => {
        if (current) setJobs(list.data);
      })
      .catch((e: unknown) => {
        if (current) setError(e);
      });
    return () => {
      current = false;
    };
  }, [status]);
  useEffect(() => {
    let current = true;
    setDetail(null);
    if (open)
      api<NonNullable<typeof detail>>("GET", `/page/admin/documents/${open}`)
        .then((d) => {
          if (current) setDetail(d);
        })
        .catch((e: unknown) => {
          if (current) setError(e);
        });
    return () => {
      current = false;
    };
  }, [open]);
  const usd = (n: number) =>
    new Intl.NumberFormat("en", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 4,
    }).format(n);
  return (
    <section className="card">
      <h1>{t.jobs}</h1>
      {error !== null && <p className="error">{plain(error, t)}</p>}
      <select
        aria-label={t.status}
        value={status}
        onChange={(e) => {
          setStatus(e.target.value);
        }}
      >
        <option value="">{t.allStatuses}</option>
        {Object.keys(t.statuses).map((s) => (
          <option key={s} value={s}>
            {statusLabel(t, s)}
          </option>
        ))}
      </select>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>{t.date}</th>
              <th>{t.organisation}</th>
              <th>{t.status}</th>
              <th>{t.pages}</th>
              <th>{t.failuresLabel}</th>
              <th>{t.costPerPage}</th>
            </tr>
          </thead>
          <tbody>
            {jobs?.map((j) => (
              <tr
                key={j.id}
                className="clickable"
                data-testid="job"
                onClick={() => {
                  setOpen(open === j.id ? null : j.id);
                }}
              >
                <td>{date(j.created_at)}</td>
                <td dir="auto">{j.org_name}</td>
                <td>{statusLabel(t, j.status)}</td>
                <td className="num">
                  {j.page_count === null ? "—" : number(j.page_count)}
                </td>
                <td>
                  {Object.entries(j.failures)
                    .map(([reason, n]) => `${reason} × ${String(n)}`)
                    .join(t.listSeparator) || "—"}
                </td>
                <td className="num" data-testid="cost">
                  {j.cost_per_page === null ? "—" : usd(j.cost_per_page)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {detail && (
        <div className="notice">
          <h2 dir="ltr">{open}</h2>
          <ul>
            {detail.calls.map((c) => (
              <li key={`${c.purpose}-${c.model}`} dir="ltr">
                {c.purpose} · {c.model} · {c.calls} ({c.failed} failed) ·{" "}
                {usd(c.cost_usd)}
              </li>
            ))}
          </ul>
          <ul>
            {detail.failures.map((f, i) => (
              <li key={i}>
                {f.reason} · {fill(t.pdfPageN, { n: f.locator.pdf_page })}
                {f.detail && ` · ${f.detail}`}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function Audit() {
  const { t } = useI18n();
  const [rows, setRows] = useState<
    {
      id: number;
      actor: string | null;
      action: string;
      target: string | null;
      org_id: string | null;
      detail: unknown;
      created_at: string;
    }[]
  >([]);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    api<{ data: typeof rows }>("GET", "/page/admin/audit")
      .then((list) => {
        setRows(list.data);
      })
      .catch(setError);
  }, []);
  return (
    <section className="card">
      <h1>{t.auditLog}</h1>
      {error !== null && <p className="error">{plain(error, t)}</p>}
      <div className="table-scroll">
        <table>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} data-testid="audit-row">
                <td>{new Date(r.created_at).toLocaleString()}</td>
                <td dir="ltr">{r.actor}</td>
                <td dir="ltr">{r.action}</td>
                <td dir="ltr">
                  {r.org_id} {r.target}
                </td>
                <td dir="ltr">
                  <code>{JSON.stringify(r.detail)}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** A key's concurrency cap (1–50), saved with its own button, not per keystroke. */
function ConcurrencyField(props: {
  label: string;
  value: number;
  onSave: (value: number) => Promise<void>;
}) {
  const { t } = useI18n();
  const [value, setValue] = useState<number | null>(props.value);
  const [busy, setBusy] = useState(false);
  const valid = value !== null && value >= 1 && value <= 50;
  return (
    <span className="row">
      <label className="inline small">
        {t.concurrency}
        <NumberInput label={props.label} value={value} onChange={setValue} />
      </label>
      <button
        type="button"
        className="secondary small"
        disabled={!valid || value === props.value || busy}
        onClick={() => {
          if (!valid) return;
          setBusy(true);
          void props.onSave(value).finally(() => {
            setBusy(false);
          });
        }}
      >
        {t.saveFix}
      </button>
    </span>
  );
}
