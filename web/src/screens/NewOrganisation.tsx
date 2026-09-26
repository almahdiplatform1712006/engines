import { useState } from "react";
import { authClient } from "../api.ts";
import { field } from "../forms.ts";
import { useI18n } from "../i18n.tsx";
import { navigate } from "../router.tsx";

/** A slug Better Auth accepts: the name's Latin letters, plus a random tail. */
function slugFor(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  const tail =
    crypto.getRandomValues(new Uint32Array(1))[0]?.toString(36) ?? "";
  return base === "" ? `org-${tail}` : `${base}-${tail}`;
}

export function NewOrganisation({
  onCreated,
}: {
  onCreated: () => Promise<void>;
}) {
  const { t } = useI18n();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(name: string) {
    setBusy(true);
    const result = await authClient.organization.create({
      name,
      slug: slugFor(name),
    });
    setBusy(false);
    if (result.error) {
      setError(result.error.message ?? t.error);
      return;
    }
    await onCreated();
    navigate(`/o/${result.data.id}/keys`);
  }

  return (
    <section className="card narrow">
      <h1>{t.newOrganisation}</h1>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit(field(e.currentTarget, "name"));
        }}
      >
        <label>
          {t.organisationName}
          <input name="name" required maxLength={100} />
        </label>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" disabled={busy}>
          {t.create}
        </button>
      </form>
    </section>
  );
}
