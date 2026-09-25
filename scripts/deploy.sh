#!/usr/bin/env bash
# Deploys Engines to staging or production (E-22) inside its own walls:
# its own Cloud Run services, Cloud SQL server, buckets and secrets in
# Almahdi's project, running as engines-runtime. Touches nothing of Almahdi's.
#
#   scripts/deploy.sh staging            # prints every command, runs none
#   scripts/deploy.sh production --yes   # runs them (the owner approves first)
#
# Order: build the image, record what's serving now (for rollback), run the
# migrations as their own job, then the API and the worker, then smoke checks.
# Reads GCP_PROJECT_ID, GCP_REGION and the ENGINES_* values setup-gcp.sh wrote
# to .env, plus PUBLIC_URL_<ENV> and AI_MODEL.
set -euo pipefail

ENV_NAME="${1:-}"
RUN=false
[[ "${2:-}" == "--yes" ]] && RUN=true
case "$ENV_NAME" in
  staging) PREFIX=engines-staging; DB_ENV=dev ;;
  production) PREFIX=engines; DB_ENV=prod ;;
  *) echo "usage: scripts/deploy.sh staging|production [--yes]" >&2; exit 2 ;;
esac

# shellcheck disable=SC1091
[[ -f .env ]] && set -a && . ./.env && set +a
: "${GCP_PROJECT_ID:?run scripts/setup-gcp.sh first}"
: "${GCP_REGION:?run scripts/setup-gcp.sh first}"
: "${ENGINES_RUNTIME_SA:?run scripts/setup-gcp.sh first}"
: "${AI_MODEL:?set AI_MODEL (the model name is config)}"
DB_CONN_VAR="ENGINES_DB_$(tr '[:lower:]' '[:upper:]' <<<"$DB_ENV")_CONNECTION"
DB_CONN="${!DB_CONN_VAR:?$DB_CONN_VAR missing; run scripts/setup-gcp.sh}"
URL_VAR="PUBLIC_URL_$(tr '[:lower:]' '[:upper:]' <<<"$ENV_NAME")"
# Sign-in (Better Auth, Google's callback) needs the public address.
PUBLIC_URL="${!URL_VAR:?set $URL_VAR in .env: the address the page is served at}"

SHA=$(git rev-parse --short=12 HEAD)
if [[ -n "$(git status --porcelain)" ]]; then
  echo "The working tree has changes: deploy a commit, not a working tree." >&2
  exit 1
fi
REPO="$GCP_REGION-docker.pkg.dev/$GCP_PROJECT_ID/engines"
IMAGE="$REPO/engines:$SHA"
API="$PREFIX-api"
WORKER="$PREFIX-worker"
MIGRATE="$PREFIX-migrate"
RECORD="deploy/$ENV_NAME-previous.env"

run() {
  printf '+ %s\n' "$*"
  if $RUN; then "$@"; fi
}

echo "Deploying $SHA to $ENV_NAME (project $GCP_PROJECT_ID, $GCP_REGION)."
$RUN || echo "Dry run: nothing is changed. Add --yes once the owner has approved."

# Secrets, by name only; their values stay in Secret Manager.
SECRETS="DATABASE_URL=engines-database-url-$DB_ENV:latest"
SECRETS+=",AUTH_SECRET=engines-auth-secret-$ENV_NAME:latest"
SECRETS+=",OPENROUTER_API_KEY=engines-openrouter-key-$DB_ENV:latest"
SECRETS+=",GOOGLE_CLIENT_SECRET=engines-google-oauth-client-secret:latest"
# Staging has its own buckets (docs/release.md), never production's.
if [[ "$ENV_NAME" == staging ]]; then
  UPLOADS="${ENGINES_STAGING_BUCKET_UPLOADS:?create the staging buckets first, see docs/release.md}"
  PAGES="${ENGINES_STAGING_BUCKET_PAGES:?}"; RESULTS="${ENGINES_STAGING_BUCKET_RESULTS:?}"
else
  UPLOADS="$ENGINES_BUCKET_UPLOADS"; PAGES="$ENGINES_BUCKET_PAGES"; RESULTS="$ENGINES_BUCKET_RESULTS"
fi
ENV_VARS="STORAGE=gcs,GCS_BUCKET_UPLOADS=$UPLOADS,GCS_BUCKET_PAGES=$PAGES,GCS_BUCKET_RESULTS=$RESULTS"
ENV_VARS+=",AI_MODEL=$AI_MODEL,GOOGLE_CLIENT_ID=${GOOGLE_CLIENT_ID:-}"
ENV_VARS+=",PUBLIC_URL=$PUBLIC_URL"
COMMON=(--project="$GCP_PROJECT_ID" --region="$GCP_REGION")
RUNTIME=(--service-account="$ENGINES_RUNTIME_SA" --set-cloudsql-instances="$DB_CONN"
  --set-secrets="$SECRETS" --set-env-vars="$ENV_VARS" --labels=service=engines)

echo; echo "1. Build the image"
if $RUN && gcloud artifacts repositories describe engines --location="$GCP_REGION" \
  --project="$GCP_PROJECT_ID" >/dev/null 2>&1; then
  echo "(the engines image repository exists)"
else
  run gcloud artifacts repositories create engines --repository-format=docker \
    --location="$GCP_REGION" --project="$GCP_PROJECT_ID" --labels=service=engines
fi
run gcloud builds submit --tag="$IMAGE" --project="$GCP_PROJECT_ID"

echo; echo "2. Record what's serving now, for rollback ($RECORD)"
if $RUN; then
  mkdir -p deploy
  API_REVISION=""
  WORKER_IMAGE=""
  if gcloud run services describe "$API" "${COMMON[@]}" >/dev/null 2>&1; then
    API_REVISION=$(gcloud run services describe "$API" "${COMMON[@]}" \
      --format='value(status.traffic[0].revisionName)')
    [[ -n "$API_REVISION" ]] || { echo "Can't read $API's serving revision: stopping." >&2; exit 1; }
  fi
  if gcloud beta run worker-pools describe "$WORKER" "${COMMON[@]}" >/dev/null 2>&1; then
    WORKER_IMAGE=$(gcloud beta run worker-pools describe "$WORKER" "${COMMON[@]}" \
      --format='value(template.containers[0].image)')
    [[ -n "$WORKER_IMAGE" ]] || { echo "Can't read $WORKER's image: stopping." >&2; exit 1; }
  fi
  # Earlier records are kept, so re-running after a bad deploy can still go back further.
  [[ -f "$RECORD" ]] && cp "$RECORD" "deploy/$ENV_NAME-$(date -u +%Y%m%dT%H%M%SZ).env"
  {
    echo "API_REVISION=$API_REVISION"
    echo "WORKER_IMAGE=$WORKER_IMAGE"
    echo "RECORDED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  } >"$RECORD"
  cat "$RECORD"
else
  echo "+ (writes the API's serving revision and the worker's image to $RECORD)"
fi

echo; echo "3. Migrations, as their own job, before any traffic"
run gcloud run jobs deploy "$MIGRATE" "${COMMON[@]}" --image="$IMAGE" \
  --command=node --args=src/shared/db/migrate-cli.ts "${RUNTIME[@]}" --max-retries=0
run gcloud run jobs execute "$MIGRATE" "${COMMON[@]}" --wait

echo; echo "4. The API service and the worker pool"
run gcloud run deploy "$API" "${COMMON[@]}" --image="$IMAGE" "${RUNTIME[@]}" \
  --allow-unauthenticated --port=8080 --memory=2Gi --cpu=2
run gcloud beta run worker-pools deploy "$WORKER" "${COMMON[@]}" --image="$IMAGE" \
  --command=node --args=src/worker/main.ts "${RUNTIME[@]}" --memory=4Gi --cpu=2

echo; echo "5. Smoke checks"
if $RUN; then
  URL=${PUBLIC_URL:-$(gcloud run services describe "$API" "${COMMON[@]}" --format='value(status.url)')}
  fail() { echo "Smoke check failed: $1. Roll back: scripts/rollback.sh $ENV_NAME --yes" >&2; exit 1; }
  curl -fsS "$URL/v1/health" >/dev/null || fail "/v1/health"
  page=$(curl -fsS "$URL/") || fail "the page"
  [[ "$page" == *'dir="rtl"'* ]] || fail "the page isn't right-to-left"
  curl -fsS "$URL/v1/openapi.json" >/dev/null || fail "/v1/openapi.json"
  echo "health, the right-to-left page and openapi.json all answer"
else
  echo "+ curl \$URL/v1/health; the page's dir=\"rtl\"; /v1/openapi.json"
fi
echo; echo "Done. Roll back with: scripts/rollback.sh $ENV_NAME --yes"
