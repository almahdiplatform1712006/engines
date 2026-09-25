import { useCallback, useEffect, useState } from "react";
import { api, authClient, type Me } from "./api.ts";
import { useI18n } from "./i18n.tsx";
import { matchOrg, navigate, safeDecode, usePath } from "./router.tsx";
import { AcceptInvitation } from "./screens/AcceptInvitation.tsx";
import { NewOrganisation } from "./screens/NewOrganisation.tsx";
import { OrganisationShell } from "./screens/OrganisationShell.tsx";
import { SignIn } from "./screens/SignIn.tsx";

export function App() {
  const { t, toggle } = useI18n();
  const path = usePath();
  const session = authClient.useSession();
  const [me, setMe] = useState<Me | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setMe(await api<Me>("GET", "/page/me"));
      setFailed(null);
    } catch (e) {
      setFailed(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const signedIn = session.data != null;
  useEffect(() => {
    if (signedIn) void refresh();
    else setMe(null);
  }, [signedIn, refresh]);

  // Where a signed-in person with nowhere in particular to go lands.
  useEffect(() => {
    if (!me) return;
    if (path === "/" || path === "/sign-in") {
      const first = me.organisations[0];
      navigate(first ? `/o/${first.id}/books` : "/organisations/new", true);
    }
  }, [me, path]);

  let screen: React.ReactNode;
  if (session.isPending) screen = <p className="muted">{t.loading}</p>;
  else if (!signedIn) screen = <SignIn />;
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
  else if (path.startsWith("/invitations/"))
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
          {me && <OrganisationPicker me={me} current={matchOrg(path)?.orgId} />}
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
