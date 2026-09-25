import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { api, ApiError, authClient, type Me } from "./api.ts";
import { fill, useI18n } from "./i18n.tsx";
import { Link, matchOrg, navigate, safeDecode, usePath } from "./router.tsx";

import { AcceptInvitation } from "./screens/AcceptInvitation.tsx";
import { NewOrganisation } from "./screens/NewOrganisation.tsx";
import { OrganisationShell } from "./screens/OrganisationShell.tsx";
import { SignIn } from "./screens/SignIn.tsx";

// The back office is only ever opened by the owner: loaded when it is.
const Admin = lazy(() =>
  import("./screens/Admin.tsx").then((m) => ({ default: m.Admin })),
);

export function App() {
  const { t, toggle } = useI18n();
  const path = usePath();
  const session = authClient.useSession();
  const [me, setMe] = useState<Me | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  const [checked, setChecked] = useState(false);
  const refresh = useCallback(async () => {
    try {
      setMe(await api<Me>("GET", "/page/me"));
      setFailed(null);
    } catch (e) {
      // Not signed in (and no visit): the sign-in screen.
      if (e instanceof ApiError && e.status === 401) setMe(null);
      else setFailed(e instanceof Error ? e.message : String(e));
    } finally {
      setChecked(true);
    }
  }, []);

  // A visitor from another platform has no sign-in, only a visit cookie the
  // page can't see: /page/me says which it is.
  const signedIn = session.data != null;
  useEffect(() => {
    if (!session.isPending) void refresh();
  }, [signedIn, session.isPending, refresh]);
  const visit = me?.visit;

  // Where a signed-in person with nowhere in particular to go lands; a
  // visitor only ever goes to their outline or document.
  useEffect(() => {
    if (!me) return;
    if (me.visit) {
      const orgId = me.active?.id ?? "";
      if (!path.startsWith(`/o/${orgId}/`))
        navigate(
          me.visit.outline_id
            ? `/o/${orgId}/outlines/${me.visit.outline_id}`
            : `/o/${orgId}/documents/${me.visit.document_id ?? ""}`,
          true,
        );
      return;
    }
    if (path === "/" || path === "/sign-in") {
      const first = me.organisations[0];
      navigate(first ? `/o/${first.id}/books` : "/organisations/new", true);
    }
  }, [me, path]);

  let screen: React.ReactNode;
  if (session.isPending || !checked)
    screen = <p className="muted">{t.loading}</p>;
  else if (!signedIn && !visit) screen = <SignIn />;
  else if (!me)
    screen = failed ? (
      <p className="error" role="alert">
        {t.error}: {failed}
      </p>
    ) : (
      <p className="muted">{t.loading}</p>
    );
  else if (path === "/organisations/new")
    screen = <NewOrganisation onCreated={refresh} />;
  else if (path.startsWith("/admin") && me.user?.super_admin) {
    const [, , tab = "organisations", id] = path.split("/");
    screen = (
      <Suspense fallback={<p className="muted">{t.loading}</p>}>
        <Admin tab={tab} id={id} />
      </Suspense>
    );
  } else if (path.startsWith("/invitations/"))
    screen = (
      <AcceptInvitation
        id={safeDecode(path.slice("/invitations/".length))}
        onAccepted={refresh}
      />
    );
  else {
    const match = matchOrg(path);
    const organisation =
      match && me.organisations.find((o) => o.id === match.orgId);
    screen =
      match && organisation ? (
        <OrganisationShell
          me={me}
          visitor={visit !== undefined}
          organisation={organisation}
          screen={match.screen}
          rest={match.rest}
        />
      ) : (
        <p className="muted">
          {me.organisations.length === 0 ? t.noOrganisation : t.loading}
        </p>
      );
  }

  return (
    <div className="app">
      <header className="topbar">
        <strong className="brand">{t.appName}</strong>
        <div className="topbar-actions">
          {visit && (
            <a
              className="link"
              href={visit.return_url}
              data-testid="back"
              onClick={(e) => {
                e.preventDefault();
                void leaveVisit(visit.return_url, path);
              }}
            >
              {fill(t.backTo, { host: new URL(visit.return_url).host })}
            </a>
          )}
          {me && !visit && (
            <OrganisationPicker me={me} current={matchOrg(path)?.orgId} />
          )}
          {me?.user?.super_admin && (
            <Link to="/admin/organisations" className="link">
              {t.backOffice}
            </Link>
          )}
          <button
            type="button"
            className="link"
            onClick={toggle}
            data-testid="language"
          >
            {t.switchLanguage}
          </button>
          {signedIn && (
            <button
              type="button"
              className="link"
              onClick={() => {
                void authClient.signOut().then(() => {
                  navigate("/sign-in", true);
                });
              }}
            >
              {t.signOut}
            </button>
          )}
        </div>
      </header>
      <main>{screen}</main>
    </div>
  );
}

function OrganisationPicker({
  me,
  current,
}: {
  me: Me;
  current: string | undefined;
}) {
  const { t } = useI18n();
  return (
    <select
      aria-label={t.organisations}
      value={current ?? ""}
      onChange={(e) => {
        navigate(
          e.target.value === ""
            ? "/organisations/new"
            : `/o/${e.target.value}/keys`,
        );
      }}
    >
      {me.organisations.map((o) => (
        <option key={o.id} value={o.id}>
          {o.name}
        </option>
      ))}
      <option value="">+ {t.newOrganisation}</option>
    </select>
  );
}

/**
 * "Back" to the platform: the visit ends here (its cookie goes), and the
 * platform hears which document it ran, when there is one.
 */
async function leaveVisit(returnUrl: string, path: string): Promise<void> {
  await fetch("/page/leave-visit", {
    method: "POST",
    credentials: "same-origin",
  }).catch(() => undefined);
  const url = new URL(returnUrl);
  const document = matchOrg(path);
  if (
    document &&
    (document.screen === "documents" || document.screen === "review") &&
    document.rest[0]
  )
    url.searchParams.set("engines_document", document.rest[0]);
  location.href = url.toString();
}
