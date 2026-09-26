import { useEffect, useState } from "react";
import { api, authClient } from "../api.ts";
import { field } from "../forms.ts";
import { useI18n } from "../i18n.tsx";

export function SignIn() {
  const { t } = useI18n();
  const [mode, setMode] = useState<"in" | "up">("in");
  const [error, setError] = useState<string | null>(() =>
    new URLSearchParams(location.search).get("error") === "account_not_linked"
      ? t.googleNotLinked
      : null,
  );
  const [busy, setBusy] = useState(false);
  // Google sign-in shows only where Engines has its OAuth client.
  const [google, setGoogle] = useState(false);
  useEffect(() => {
    void api<{ google: boolean }>("GET", "/page/config")
      .then((c) => {
        setGoogle(c.google);
      })
      .catch(() => undefined);
  }, []);

  async function submit(form: FormData) {
    setBusy(true);
    setError(null);
    const email = field(form, "email");
    // Passwords are taken exactly as typed, spaces and all.
    const password = field(form, "password", false);
    const result =
      mode === "up"
        ? await authClient.signUp.email({
            email,
            password,
            name: field(form, "name"),
          })
        : await authClient.signIn.email({ email, password });
    setBusy(false);
    if (result.error) setError(result.error.message ?? t.error);
  }

  return (
    <section className="card narrow">
      <h1>{mode === "in" ? t.signIn : t.signUp}</h1>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit(new FormData(e.currentTarget));
        }}
      >
        {mode === "up" && (
          <label>
            {t.name}
            <input name="name" required autoComplete="name" />
          </label>
        )}
        <label>
          {t.email}
          <input
            name="email"
            type="email"
            dir="ltr"
            required
            autoComplete="email"
          />
        </label>
        <label>
          {t.password}
          <input
            name="password"
            type="password"
            dir="ltr"
            required
            minLength={10}
            autoComplete={mode === "up" ? "new-password" : "current-password"}
          />
          {mode === "up" && <small className="muted">{t.passwordHint}</small>}
        </label>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" disabled={busy}>
          {mode === "in" ? t.signIn : t.signUp}
        </button>
      </form>
      {google && (
        <>
          <p className="divider">{t.or}</p>
          <button
            type="button"
            className="secondary"
            onClick={() => {
              void authClient.signIn.social({
                provider: "google",
                // Back where they were, such as an invitation link.
                callbackURL: location.pathname,
                errorCallbackURL: location.pathname,
              });
            }}
          >
            {t.withGoogle}
          </button>
        </>
      )}
      <p className="muted">
        {mode === "in" ? t.noAccount : t.haveAccount}{" "}
        <button
          type="button"
          className="link"
          onClick={() => {
            setMode(mode === "in" ? "up" : "in");
            setError(null);
          }}
        >
          {mode === "in" ? t.signUp : t.signIn}
        </button>
      </p>
    </section>
  );
}
