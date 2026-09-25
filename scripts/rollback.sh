#!/usr/bin/env bash
# Puts back what deploy.sh recorded before the last deploy (E-22): the API's
# previous revision takes all traffic, and the worker pool runs its previous
# image. Migrations are not undone: they only ever add (docs/release.md).
#
#   scripts/rollback.sh staging|production [--yes]
set -euo pipefail

ENV_NAME="${1:-}"
RUN=false
[[ "${2:-}" == "--yes" ]] && RUN=true
case "$ENV_NAME" in
  staging) PREFIX=engines-staging ;;
  production) PREFIX=engines ;;
  *) echo "usage: scripts/rollback.sh staging|production [--yes]" >&2; exit 2 ;;
esac
# shellcheck disable=SC1091
[[ -f .env ]] && set -a && . ./.env && set +a
RECORD="deploy/$ENV_NAME-previous.env"
[[ -f "$RECORD" ]] || { echo "No $RECORD: nothing recorded to roll back to." >&2; exit 1; }
# shellcheck disable=SC1090
. "$RECORD"
COMMON=(--project="${GCP_PROJECT_ID:?}" --region="${GCP_REGION:?}")

run() {
  printf '+ %s\n' "$*"
  if $RUN; then "$@"; fi
}

echo "Rolling $ENV_NAME back to what was serving at ${RECORDED_AT:-?}."
$RUN || echo "Dry run: add --yes to do it."
if [[ -n "${API_REVISION:-}" ]]; then
  run gcloud run services update-traffic "$PREFIX-api" "${COMMON[@]}" --to-revisions="$API_REVISION=100"
fi
if [[ -n "${WORKER_IMAGE:-}" ]]; then
  run gcloud beta run worker-pools deploy "$PREFIX-worker" "${COMMON[@]}" --image="$WORKER_IMAGE"
fi
