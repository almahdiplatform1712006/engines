import { useEffect, useState } from "react";
import { authClient } from "../api.ts";
import { useI18n } from "../i18n.tsx";
import { navigate } from "../router.tsx";

export function AcceptInvitation(props: {
  id: string;
  onAccepted: () => Promise<void>;
}) {
  const { t } = useI18n();
  const [organisation, setOrganisation] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void authClient.organization
      .getInvitation({ query: { id: props.id } })
      .then((r) => {
        if (r.error) setError(r.error.message ?? t.error);
        else setOrganisation(r.data.organizationName);
      });
  }, [props.id, t.error]);

  async function accept() {
    const result = await authClient.organization.acceptInvitation({
      invitationId: props.id,
    });
    if (result.error) {
      setError(result.error.message ?? t.error);
      return;
    }
    await props.onAccepted();
    navigate(`/o/${result.data.member.organizationId}/keys`);
  }

  return (
    <section className="card narrow">
      <h1>{t.acceptInvitation}</h1>
      {organisation && (
        <p>
          {t.invitationFor} <strong>{organisation}</strong>
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <button
        type="button"
        disabled={!organisation}
        onClick={() => void accept()}
      >
        {t.acceptInvitation}
      </button>
    </section>
  );
}
