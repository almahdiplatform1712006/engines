# 0002 — Accounts on the page, API keys our own

Status: accepted (E-15). Builds on spec #1 §5 (decision Q12) and ADR 0001.

## Context

E-15 asks for Better Auth with organisations and members, email and Google sign-in, "and its API-key plugin with organisation-owned keys", replacing E-05's key check behind the same `authenticate` function.

Better Auth 1.7.6 (the pinned version) has no API-key plugin in its core package. E-05's keys already do what Engines needs, and Better Auth's keys wouldn't:

- they're hashed at rest;
- each has its own concurrency cap, queue limit and model provider (decisions Q22, Q35);
- idempotency is scoped by organisation, and the admission lock by key.

## Decision

**Better Auth owns people; Engines owns keys.**

- **Tables.** Better Auth runs on Engines' Postgres with Engines' naming: `users`, `sessions`, `accounts`, `verifications`, `members`, `invitations`, snake_case columns and prefixed ids (`usr_`, `org_`, …). Its organisation model _is_ Engines' `organisations` table, so every `org_id` in the schema is the organisation people sign in to.
  - Migration `0009` is written by hand from Better Auth's schema.
  - A test runs Better Auth's own migration planner against the migrated database and fails if anything is left to create.
- **Tables without `org_id`.** `users`, `sessions`, `accounts` and `verifications` belong to a person, and one person can be in several organisations, so they're the exception to "every table carries `org_id`" (spec §6). `members` and `invitations` carry it.
- **Two ways in, one caller.** `/v1/` accepts either an API key (`Authorization: Bearer`) or the page's sign-in cookie. Both end in the same `Caller { orgId, apiKeyId, userId }`, so the routes don't know which way was used. E-05's `authenticate` became `authenticateKey`, one of the two; the `/v1/` middleware picks between them.
  - When the header is sent, it wins; a bad key is `401` and never falls back to the cookie.
  - The page acts through a **built-in key** per organisation: an `api_keys` row with `built_in = true` whose secret is thrown away when it's made, so nobody can send it.
  - The page's documents therefore share one concurrency cap, one queue limit and one idempotency space per organisation, like any other key's. The built-in key is never listed, revoked or accepted as a Bearer key.
- **Which organisation.** The page keeps the organisation in its URL (`/o/<org_id>/…`) and names it on every call (`Engines-Organisation` header). Image and download links can't send a header, so a read (`GET`) may name it as `?org=` instead. It is always checked against `members`. Otherwise it falls back to the session's active organisation, then the person's first.
  - Better Auth's active organisation is per session, so two tabs would otherwise move each other.
  - Naming an organisation you aren't in acts for none: `401` on `/v1/`, and nothing on the page.
- **CSRF.** Cookies go along on any request, so a state-changing request that carries a sign-in cookie must have an `Origin` of `PUBLIC_URL` or `AUTH_TRUSTED_ORIGINS`, else `403`. A missing `Origin` is refused too. Better Auth does the same on its own routes, and cookies are `SameSite=Lax`.
- **Page-only routes** live under `/page/`, behind the cookie:
  - `GET /page/me`
  - `GET`/`POST /page/keys` and `DELETE /page/keys/{id}`, managed by owners and admins only (`403` for members)
  - organisation, member and invitation changes, which go through Better Auth's own `/api/auth/organization/*` routes.
- **Invitations without email.** Engines doesn't send mail yet. An invitation is a link the inviter copies, so nobody's email is verified by mail. `requireEmailVerificationOnInvitation` is therefore off. Accepting still needs the invited email address signed in, plus the link's unguessable id.
  - Anyone who signs up with an address they don't own could accept that address's invitation, but only if they hold its link.
  - Turn the option back on when email verification exists.
- **Google and existing accounts.** Better Auth refuses to link Google to an existing password account whose email isn't verified (it guards against pre-hijacking). The page explains this and asks for the password.
- **No organisation deletion from the page.** Documents, keys and the credit ledger belong to the organisation.
- **Rate limits.** Better Auth's rate limits key on `X-Forwarded-For` (Cloud Run). They're kept in memory per instance: good enough for sign-in, not a quota.

## Consequences

- API keys, caps and providers stay where E-13, E-14 and E-20 already use them. The back office (E-20) manages keys with the same functions as the page.
- The E-05 integration test runs unchanged: `Bearer` keys work exactly as before.
- Session links for other platforms (E-21) are a third way in with its own narrow scope. They are not Better Auth sessions, which would grant the whole organisation.
