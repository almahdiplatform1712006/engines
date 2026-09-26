import { useCallback, useEffect, useState } from "react";
import { authClient } from "../api.ts";
import { field } from "../forms.ts";
import { useI18n } from "../i18n.tsx";
import { canManage, type Organisation } from "./OrganisationShell.tsx";

interface Member {
  id: string;
  role: string;
  user: { name: string; email: string };
}
interface Invitation {
  id: string;
  email: string;
  role: string;
  status: string;
}

export function Members({ organisation }: { organisation: Organisation }) {
  const { t } = useI18n();
  const [members, setMembers] = useState<Member[] | null>(null);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [link, setLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const organizationId = organisation.id;

  const load = useCallback(async () => {
    const full = await authClient.organization.getFullOrganization({
      query: { organizationId },
    });
    if (full.error) {
      setError(full.error.message ?? t.error);
      return;
    }
    setMembers(full.data.members);
    setInvitations(full.data.invitations.filter((i) => i.status === "pending"));
  }, [organizationId, t.error]);
  useEffect(() => {
    void load();
  }, [load]);

  async function invite(email: string, role: "member" | "admin") {
    setError(null);
    const result = await authClient.organization.inviteMember({
      email,
      role,
      organizationId,
    });
    if (result.error) {
      setError(result.error.message ?? t.error);
      return;
    }
    setLink(`${location.origin}/invitations/${result.data.id}`);
    await load();
  }

  const roleName = (role: string) =>
    role
      .split(",")
      .map((r) => (r in t.roles ? t.roles[r as keyof typeof t.roles] : r))
      .join(t.listSeparator);

  return (
    <section className="card">
      <h1>{t.members}</h1>
      {canManage(organisation) && (
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            const data = new FormData(e.currentTarget);
            void invite(
              field(data, "email"),
              data.get("role") === "admin" ? "admin" : "member",
            );
          }}
        >
          <input
            name="email"
            type="email"
            dir="ltr"
            required
            aria-label={t.inviteEmail}
            placeholder={t.inviteEmail}
          />
          <select name="role" aria-label={t.role} defaultValue="member">
            <option value="member">{t.roles.member}</option>
            <option value="admin">{t.roles.admin}</option>
          </select>
          <button type="submit">{t.invite}</button>
        </form>
      )}
      {link && (
        <div className="notice" role="status">
          <p>{t.inviteLink}</p>
          <code dir="ltr" className="secret">
            {link}
          </code>
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {members === null ? (
        <p className="muted">{t.loading}</p>
      ) : (
        <ul className="list">
          {members.map((m) => (
            <li key={m.id}>
              <div>
                <strong>{m.user.name}</strong>
                <div className="muted small" dir="ltr">
                  {m.user.email}
                </div>
              </div>
              <span className="badge">{roleName(m.role)}</span>
            </li>
          ))}
        </ul>
      )}
      {invitations.length > 0 && (
        <>
          <h2>{t.invitations}</h2>
          <ul className="list">
            {invitations.map((i) => (
              <li key={i.id}>
                <span dir="ltr">{i.email}</span>
                <span className="badge">{roleName(i.role)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
