import type { Me } from "../api.ts";
import { useI18n } from "../i18n.tsx";
import { Link } from "../router.tsx";
import { Keys } from "./Keys.tsx";
import { Members } from "./Members.tsx";
import { Usage } from "./Usage.tsx";

export interface Organisation {
  id: string;
  name: string;
  role: string;
}

const SCREENS = ["keys", "members", "usage"] as const;

export function OrganisationShell(props: {
  me: Me;
  organisation: Organisation;
  screen: string;
}) {
  const { t } = useI18n();
  const { organisation } = props;
  const labels: Record<(typeof SCREENS)[number], string> = {
    keys: t.keys,
    members: t.members,
    usage: t.usage,
  };
  return (
    <div className="shell">
      <nav className="tabs" aria-label={organisation.name}>
        {SCREENS.map((s) => (
          <Link
            key={s}
            to={`/o/${organisation.id}/${s}`}
            className={props.screen === s ? "tab active" : "tab"}
          >
            {labels[s]}
          </Link>
        ))}
      </nav>
      {/* Keyed by organisation: nothing on a screen carries over to the next one. */}
      {props.screen === "members" ? (
        <Members key={organisation.id} organisation={organisation} />
      ) : props.screen === "usage" ? (
        <Usage key={organisation.id} organisation={organisation} />
      ) : (
        <Keys key={organisation.id} organisation={organisation} />
      )}
    </div>
  );
}

export function canManage(organisation: Organisation): boolean {
  return organisation.role === "owner" || organisation.role === "admin";
}
