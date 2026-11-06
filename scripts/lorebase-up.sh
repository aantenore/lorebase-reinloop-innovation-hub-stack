#!/usr/bin/env bash
# Lorebase for the hub, in its own compose project (hub-lorebase): Postgres + migrations + Keeper and, on request,
# Herald (compose profile `mcp`). By default the published images of LOREBASE_VERSION (deploy/lorebase.settings.env)
# run, ghcr.io/aantenore/lorebase and lorebase-ml, pulled when missing, with the compose file and the configuration of
# that release committed under deploy/ (deploy/compose/, deploy/lorebase.yaml; `sync` refreshes them from a checkout).
# LOREBASE_FROM_SOURCE=1 builds the images from a Lorebase checkout instead (LOREBASE_REPO, default ../lorebase) and
# runs that checkout's compose file and example configuration.
#
# Two env files: deploy/lorebase.settings.env (committed demo settings) and deploy/lorebase.env (local secrets and
# ports, generated when missing; missing secrets are appended to an existing one). The image, tag, pull policy and
# configuration file come from the shell, else the settings file, else the defaults above (LOREBASE_IMAGE,
# LOREBASE_ML_IMAGE, LOREBASE_TAG, LOREBASE_PULL_POLICY, LOREBASE_CONFIG_FILE); a value of theirs in the local env
# file is ignored, so a stale pin there cannot run another image than the configured release.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${LOREBASE_ENV_FILE:-$ROOT/deploy/lorebase.env}"
SETTINGS_FILE="${LOREBASE_SETTINGS_FILE:-$ROOT/deploy/lorebase.settings.env}"
PROJECT="${LOREBASE_COMPOSE_PROJECT:-hub-lorebase}"
LOREBASE_REPO="${LOREBASE_REPO:-$ROOT/../lorebase}"
# The hub's additions to the Lorebase compose file (environment passed to Keeper), kept out of `sync`.
OVERRIDE_FILE="${LOREBASE_COMPOSE_OVERRIDE:-$ROOT/deploy/compose.hub.yaml}"

setting() { grep -E "^$1=" "$SETTINGS_FILE" 2>/dev/null | tail -n1 | cut -d= -f2-; }
value() { cat "$SETTINGS_FILE" "$ENV_FILE" 2>/dev/null | grep -E "^$1=" | tail -n1 | cut -d= -f2-; }
# Shell, then the settings file (or the lookup given as third argument), then the default.
pin() { local v="${!1:-}"; [ -n "$v" ] || v="$(${3:-setting} "$1")"; [ -n "$v" ] || v="$2"; printf '%s' "$v"; }

LOREBASE_VERSION="$(pin LOREBASE_VERSION '')"
[ -n "$LOREBASE_VERSION" ] || { echo "LOREBASE_VERSION is not set (deploy/lorebase.settings.env)" >&2; exit 1; }
TAG_REF="v$LOREBASE_VERSION"

if [ "${LOREBASE_FROM_SOURCE:-0}" = 1 ]; then
  COMPOSE_FILE="$LOREBASE_REPO/deploy/compose/docker-compose.yaml"
  [ -f "$COMPOSE_FILE" ] || { echo "Lorebase compose file not found: $COMPOSE_FILE (set LOREBASE_REPO, or drop LOREBASE_FROM_SOURCE to run the published images)" >&2; exit 1; }
  export LOREBASE_IMAGE="$(pin LOREBASE_IMAGE lorebase)" LOREBASE_ML_IMAGE="$(pin LOREBASE_ML_IMAGE lorebase-ml)" LOREBASE_WEB_IMAGE="$(pin LOREBASE_WEB_IMAGE lorebase-web)"
  export LOREBASE_TAG="$(pin LOREBASE_TAG hub-demo)" LOREBASE_PULL_POLICY="$(pin LOREBASE_PULL_POLICY build)"
  export LOREBASE_CONFIG_FILE="$(pin LOREBASE_CONFIG_FILE "$LOREBASE_REPO/config/lorebase.example.yaml")"
else
  COMPOSE_FILE="$ROOT/deploy/compose/docker-compose.yaml"
  export LOREBASE_IMAGE="$(pin LOREBASE_IMAGE ghcr.io/aantenore/lorebase)" LOREBASE_ML_IMAGE="$(pin LOREBASE_ML_IMAGE ghcr.io/aantenore/lorebase-ml)" LOREBASE_WEB_IMAGE="$(pin LOREBASE_WEB_IMAGE ghcr.io/aantenore/lorebase-web)"
  export LOREBASE_TAG="$(pin LOREBASE_TAG "$LOREBASE_VERSION")" LOREBASE_PULL_POLICY="$(pin LOREBASE_PULL_POLICY missing)"
  export LOREBASE_CONFIG_FILE="$(pin LOREBASE_CONFIG_FILE "$ROOT/deploy/lorebase.yaml")"
fi

(
  umask 077
  if [ ! -f "$ENV_FILE" ]; then
    cat > "$ENV_FILE" <<ENV
KEEPER_HOST_PORT=${KEEPER_HOST_PORT:-8280}
POSTGRES_HOST_PORT=${POSTGRES_HOST_PORT:-5543}
ENV
    echo "generated $ENV_FILE"
  fi
  # Secrets required by the compose file (NAME:random bytes, hex encoded), added when absent.
  for entry in POSTGRES_PASSWORD:24 LOREBASE_APP_PASSWORD:24 LOREBASE_WEBHOOK_KEY:32; do
    name="${entry%%:*}"
    if ! grep -qE "^${name}=.+" "$ENV_FILE"; then
      echo "${name}=$(openssl rand -hex "${entry##*:}")" >> "$ENV_FILE"
      echo "added $name to $ENV_FILE"
    fi
  done
)
for stale in LOREBASE_IMAGE LOREBASE_ML_IMAGE LOREBASE_WEB_IMAGE LOREBASE_TAG LOREBASE_PULL_POLICY LOREBASE_CONFIG_FILE; do
  if grep -qE "^$stale=" "$ENV_FILE"; then echo "note: $stale in $ENV_FILE is ignored (this script sets it); remove the line" >&2; fi
done

# The local env file comes last, so it can override the committed settings (ports, secrets); the exported variables
# above win over both, as compose reads the shell first.
compose() { docker compose -p "$PROJECT" --env-file "$SETTINGS_FILE" --env-file "$ENV_FILE" -f "$COMPOSE_FILE" -f "$OVERRIDE_FILE" "$@"; }

wait_for() { # url, tries, accepted status regex
  for _ in $(seq 1 "$2"); do
    code="$(curl -s -o /dev/null -w '%{http_code}' -X "${4:-GET}" "$1" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' ${4:+-d '{}'} || true)"
    if echo "$code" | grep -qE "$3"; then return 0; fi
    sleep 2
  done
  return 1
}

# A file of the checkout at the release tag, with a line saying where it came from (after a shebang, else first).
copy() { # path in the checkout, destination
  local body note="# Copy of $1 at lorebase $TAG_REF (scripts/lorebase-up.sh sync): do not edit; change LOREBASE_VERSION and run sync."
  body="$(git -C "$LOREBASE_REPO" show "$TAG_REF:$1")"
  mkdir -p "$(dirname "$2")"
  case "$body" in
    '#!'*) { printf '%s\n%s\n' "${body%%$'\n'*}" "$note"; printf '%s\n' "${body#*$'\n'}"; } > "$2" ;;
    *) printf '%s\n%s\n' "$note" "$body" > "$2" ;;
  esac
}

case "${1:-up}" in
  up)
    echo "Lorebase $LOREBASE_IMAGE:$LOREBASE_TAG (pull policy $LOREBASE_PULL_POLICY), configuration $LOREBASE_CONFIG_FILE"
    compose up -d postgres migrate keeper
    PORT="$(pin KEEPER_HOST_PORT 8280 value)"
    if wait_for "http://127.0.0.1:$PORT/readyz" 60 '^200$'; then echo "Keeper ready on http://127.0.0.1:$PORT"; exit 0; fi
    echo "Keeper did not become ready; see: $0 logs" >&2; exit 1 ;;
  herald)
    compose --profile mcp up -d herald
    PORT="$(pin HERALD_HOST_PORT 8091 value)"
    if wait_for "http://127.0.0.1:$PORT/mcp" 30 '^(200|400|401|406)$' POST; then echo "Herald ready on http://127.0.0.1:$PORT/mcp"; exit 0; fi
    echo "Herald did not start; see: $0 herald-logs" >&2; exit 1 ;;
  herald-down) compose --profile mcp rm -sf herald ;;
  herald-logs) compose --profile mcp logs --tail 100 herald ;;
  down) compose --profile mcp down ;;
  destroy) compose --profile mcp down -v ;;
  ps) compose --profile mcp ps ;;
  logs) compose logs --tail 100 migrate keeper ;;
  config) shift; compose --profile mcp config "$@" ;;
  sync)
    # Refreshes deploy/compose and deploy/lorebase.yaml from the checkout at the release tag; commit the result.
    git -C "$LOREBASE_REPO" rev-parse -q --verify "$TAG_REF^{commit}" >/dev/null || { echo "tag $TAG_REF not found in $LOREBASE_REPO (set LOREBASE_REPO to a checkout that has it)" >&2; exit 1; }
    for f in docker-compose.yaml require-secrets.sh postgres/app-role.sh; do copy "deploy/compose/$f" "$ROOT/deploy/compose/$f"; done
    copy config/lorebase.example.yaml "$ROOT/deploy/lorebase.yaml"
    echo "deploy/compose and deploy/lorebase.yaml match lorebase $TAG_REF" ;;
  *) echo "usage: $0 [up|herald|herald-down|herald-logs|down|destroy|ps|logs|config [args]|sync]" >&2; exit 2 ;;
esac
