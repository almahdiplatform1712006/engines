import type { Me } from "../api.ts";
import { useI18n } from "../i18n.tsx";
import { Link } from "../router.tsx";
import { Books } from "./Books.tsx";
import { DocumentView } from "./DocumentView.tsx";
import { Keys } from "./Keys.tsx";
import { Members } from "./Members.tsx";
import { NewBook } from "./NewBook.tsx";
import { OutlineEditor } from "./OutlineEditor.tsx";
import { UploadBook } from "./UploadBook.tsx";
import { Usage } from "./Usage.tsx";

export type Organisation = Me["organisations"][number];

const TABS = ["books", "new", "keys", "members", "usage"] as const;

export function OrganisationShell(props: {
  me: Me;
  organisation: Organisation;
  screen: string;
  rest: string[];
}) {
  const { t } = useI18n();
  const { organisation } = props;
  const labels: Record<(typeof TABS)[number], string> = {
    books: t.books,
    new: t.newBook,
    keys: t.keys,
    members: t.members,
    usage: t.usage,
  };
  // Keyed by organisation: nothing on a screen carries over to the next one.
  const key = organisation.id;
  let screen: React.ReactNode;
  switch (props.screen) {
    case "new":
      screen = <NewBook key={key} organisation={organisation} />;
      break;
    case "outlines":
      screen = (
        <OutlineEditor
          key={`${key}/${props.rest[0] ?? ""}`}
          organisation={organisation}
          outlineId={props.rest[0] ?? ""}
        />
      );
      break;
    case "upload":
      screen = (
        <UploadBook
          key={`${key}/${props.rest[0] ?? ""}`}
          organisation={organisation}
          outlineId={props.rest[0] ?? ""}
        />
      );
      break;
    case "documents":
      screen = (
        <DocumentView
          key={`${key}/${props.rest[0] ?? ""}`}
          organisation={organisation}
          documentId={props.rest[0] ?? ""}
        />
      );
      break;
    case "keys":
      screen = <Keys key={key} organisation={organisation} />;
      break;
    case "members":
      screen = <Members key={key} organisation={organisation} />;
      break;
    case "usage":
      screen = <Usage key={key} organisation={organisation} />;
      break;
    default:
      screen = <Books key={key} organisation={organisation} />;
  }
  return (
    <div className="shell">
      <nav className="tabs" aria-label={organisation.name}>
        {TABS.map((s) => (
          <Link
            key={s}
            to={`/o/${organisation.id}/${s}`}
            className={props.screen === s ? "tab active" : "tab"}
          >
            {labels[s]}
          </Link>
        ))}
      </nav>
      {screen}
    </div>
  );
}

export function canManage(organisation: Organisation): boolean {
  return organisation.role === "owner" || organisation.role === "admin";
}
