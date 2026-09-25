# Releasing Engines (E-22)

Engines goes live inside its own walls: its own Cloud Run services, Cloud SQL servers, buckets, secrets and capped AI key in Almahdi's Google Cloud project, running as `engines-runtime`. Nothing here touches Almahdi's live platform. **The owner approves every production release and its time.** An agent prepares everything up to `scripts/deploy.sh production --yes`.

## Once, before the first release

`scripts/setup-gcp.sh` (E-02) made the servers, buckets, service account, AI keys and OAuth client. Add what the release needs on top:

1. **Secrets** in Secret Manager, labelled `service=engines`, readable by `engines-runtime` only:
   - `engines-database-url-dev` and `engines-database-url-prod`: `postgres://engines:<password>@/engines?host=/cloudsql/<connection name>`, the password from `engines-db-password-<env>`.
   - `engines-auth-secret-staging` and `engines-auth-secret-production`: `openssl rand -base64 32`, a different one each.
   - `engines-google-client-secret`: the OAuth client's secret.
2. **Staging's own buckets**: `gs://engines-staging-uploads` (2-day lifecycle), `gs://engines-staging-pages` and `gs://engines-staging-results` (30-day), labelled `service=engines`, `roles/storage.objectAdmin` for `engines-runtime` on each. In `.env`: `ENGINES_STAGING_BUCKET_UPLOADS`, `…_PAGES`, `…_RESULTS`.
3. **CORS** on the uploads buckets, so the page's browser uploads can read the resumable protocol's `Range` header: `gcloud storage buckets update gs://engines-uploads --cors-file=cors.json`, allowing `PUBLIC_URL_PRODUCTION` (and staging's bucket `PUBLIC_URL_STAGING`), method `PUT`, response header `Range`.
4. **`.env`**: `PUBLIC_URL_STAGING`, `PUBLIC_URL_PRODUCTION` (the services' URLs, or the domains mapped to them), `AI_MODEL`, `GOOGLE_CLIENT_ID`.
5. **OAuth client**: add `<PUBLIC_URL>/api/auth/callback/google` for each environment as an authorised redirect URI.

## Staging

```sh
scripts/deploy.sh staging          # read every command it prints
scripts/deploy.sh staging --yes    # uses the dev Cloud SQL server and the dev key
```

Then, on the staging page:

1. Sign up, then `npm run admin -- <your email>` against the dev database (through the Cloud SQL proxy) to become super admin.
2. In the back office, grant your organisation credits.
3. Run a golden-set book end to end through the page: syllabus → tree → upload → offset → progress → review → exports.
4. Run `npm run golden:score` with staging's reader settings and record the E-03 score on the release issue.

## Production

With the owner's approval and time:

```sh
scripts/deploy.sh production       # read every command it prints
scripts/deploy.sh production --yes
```

The script records the serving API revision and worker image in `deploy/production-previous.env` **before** it changes anything, runs the migrations as their own job **before** traffic moves, deploys `engines-api` and `engines-worker`, then checks `/v1/health`, the right-to-left page and `/v1/openapi.json`.

Then:

1. Sign up with the owner's account; `npm run admin -- <owner email>` against the production database.
2. Create the **Almahdi** organisation, switch on `explanation`, grant its first credits, and make its API key (shown once: straight into Almahdi's Secret Manager).
3. Process a real book with the owner's account, end to end.

## Rollback

```sh
scripts/rollback.sh production        # prints what it will do
scripts/rollback.sh production --yes  # previous API revision takes all traffic; worker back on its previous image
```

Migrations only ever add (new tables and nullable columns), so the previous revision runs on the migrated database. A migration that couldn't be run twice or rolled back would be called out in its own release note.

## The owner's checklist

Confirm each in a comment on the E-22 issue before production:

- [ ] IAM: `engines-runtime` has no role on any Almahdi resource. `setup-gcp.sh`'s isolation check, run again, is clean; the only project grant is `roles/cloudsql.client` under the `engines-sql-only` condition.
- [ ] The Cloud SQL servers are `engines-prod-db` and `engines-dev-db`, never Almahdi's.
- [ ] The monthly budget alert on `service=engines` is active.
- [ ] Bucket lifecycle rules are active: uploads 2 days, pages and results 30 days (staging's too).
- [ ] The AI keys are capped (the production key's monthly limit is set).
- [ ] No secrets in the image or the repository: the image has no `.env` (`.dockerignore`), and every secret above comes from Secret Manager.
- [ ] The previous revision is recorded in `deploy/production-previous.env`.
- [ ] Staging ran a golden book end to end; its score is on the issue.
- [ ] The release and its time are approved.
