#!/usr/bin/env bash
# Run on the target server from a git checkout of Paperclip (repo = Dockerfile + docker/).
#
# Builds the image with docker compose and starts the stack on this machine — no SSH/SCP from a laptop.
#
# If BETTER_AUTH_SECRET is unset, it is generated once and stored in
#   ${REMOTE_DIR}/.better-auth-secret (default REMOTE_DIR=/opt/paperclip).
#
# If PAPERCLIP_PUBLIC_URL is unset, defaults to https://bot.yougile.com (see script).
#
# Optional env:
#   REMOTE_DIR          directory for .env + secret file; default /opt/paperclip
#   PAPERCLIP_PORT      host port, default 3100
#   PAPERCLIP_DATA_DIR  absolute path for /paperclip volume; default ${REMOTE_DIR}/data
#   PAPERCLIP_PUBLIC_URL, BETTER_AUTH_SECRET, OPENAI_API_KEY, ANTHROPIC_API_KEY
#   DOCKER_BUILD_PLATFORM  e.g. linux/amd64 if cross-building; omit on native amd64 server
#   NODE_MEMORY_MB         Docker build-arg for Node heap during UI build (optional)
#   SKIP_BUILD=1           skip image rebuild, only recreate containers
#
# Example:
#   sudo ./scripts/server-yg.sh
#
# Compose подставляет ${BETTER_AUTH_SECRET:?…} из env-файла. Любые ручные команды
# docker compose без --env-file дадут ошибку «BETTER_AUTH_SECRET must be set»:
#   docker compose -f docker/docker-compose.quickstart.yml --env-file /opt/paperclip/.env logs -f
#   docker compose -f docker/docker-compose.quickstart.yml --env-file /opt/paperclip/.env ps
#   docker compose -f docker/docker-compose.quickstart.yml --env-file /opt/paperclip/.env down
#
# Первый instance admin (authenticated): внутри контейнера, та же БД что у сервера (образ с CLI, см. Dockerfile):
#   docker exec -it -u node -e HOME=/paperclip -w /app docker-paperclip-1 node ./cli/dist/index.js auth bootstrap-ceo

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

REMOTE_DIR="${REMOTE_DIR:-/opt/paperclip}"
PAPERCLIP_PORT="${PAPERCLIP_PORT:-3100}"
PAPERCLIP_DATA_DIR="${PAPERCLIP_DATA_DIR:-$REMOTE_DIR/data}"

COMPOSE_FILE="${REPO_ROOT}/docker/docker-compose.quickstart.yml"

SERVER_YG_SECRET_FILE="${SERVER_YG_SECRET_FILE:-$REMOTE_DIR/.better-auth-secret}"
if [[ -z "${BETTER_AUTH_SECRET:-}" ]]; then
  if [[ -f "${SERVER_YG_SECRET_FILE}" ]]; then
    BETTER_AUTH_SECRET="$(tr -d '\n\r' < "${SERVER_YG_SECRET_FILE}")"
  else
    BETTER_AUTH_SECRET="$(openssl rand -hex 32)"
    mkdir -p "$(dirname "${SERVER_YG_SECRET_FILE}")"
    umask 077
    printf '%s' "${BETTER_AUTH_SECRET}" > "${SERVER_YG_SECRET_FILE}"
    echo "==> Generated BETTER_AUTH_SECRET → ${SERVER_YG_SECRET_FILE}" >&2
  fi
fi
PAPERCLIP_PUBLIC_URL="${PAPERCLIP_PUBLIC_URL:-https://bot.yougile.com}"
# Behind nginx TLS: trust X-Forwarded-Proto (see doc/NGINX-HTTPS.md)
PAPERCLIP_TRUST_PROXY="${PAPERCLIP_TRUST_PROXY:-1}"

if [[ "${PAPERCLIP_DATA_DIR}" != /* ]]; then
  echo "PAPERCLIP_DATA_DIR must be an absolute path (got: ${PAPERCLIP_DATA_DIR})" >&2
  exit 1
fi

if [[ ! -f "${COMPOSE_FILE}" ]]; then
  echo "Missing ${COMPOSE_FILE} (run from Paperclip repo root)" >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "docker not found in PATH" >&2
  exit 1
fi

write_deploy_env() {
  local out="$1"
  BETTER_AUTH_SECRET="${BETTER_AUTH_SECRET}" \
    PAPERCLIP_PUBLIC_URL="${PAPERCLIP_PUBLIC_URL}" \
    PAPERCLIP_TRUST_PROXY="${PAPERCLIP_TRUST_PROXY}" \
    PAPERCLIP_PORT="${PAPERCLIP_PORT}" \
    PAPERCLIP_DATA_DIR="${PAPERCLIP_DATA_DIR}" \
    OPENAI_API_KEY="${OPENAI_API_KEY:-}" \
    ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}" \
    OUT="${out}" \
    python3 - <<'PY'
import os
import pathlib

def esc(s: str) -> str:
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'

out = pathlib.Path(os.environ["OUT"])
keys = [
    "BETTER_AUTH_SECRET",
    "PAPERCLIP_PUBLIC_URL",
    "PAPERCLIP_TRUST_PROXY",
    "PAPERCLIP_PORT",
    "PAPERCLIP_DATA_DIR",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
]
lines = [f"{k}={esc(os.environ.get(k, ''))}" for k in keys]
out.write_text("\n".join(lines) + "\n", encoding="utf-8")
PY
}

mkdir -p "${REMOTE_DIR}" "${PAPERCLIP_DATA_DIR}"

# Image runs as user `node` (UID/GID 1000). A root-created host dir is not writable → EACCES on /paperclip/...
PAPERCLIP_VOLUME_UID="${PAPERCLIP_VOLUME_UID:-1000}"
PAPERCLIP_VOLUME_GID="${PAPERCLIP_VOLUME_GID:-1000}"
if [[ "$(id -u)" -eq 0 ]] && command -v chown >/dev/null 2>&1; then
  chown -R "${PAPERCLIP_VOLUME_UID}:${PAPERCLIP_VOLUME_GID}" "${PAPERCLIP_DATA_DIR}"
fi

ENV_FILE="${REMOTE_DIR}/.env"
write_deploy_env "${ENV_FILE}"
chmod 600 "${ENV_FILE}"

# Compose interpolates ${BETTER_AUTH_SECRET:?…} from the process environment; export + --env-file for build/up.
export BETTER_AUTH_SECRET PAPERCLIP_PUBLIC_URL PAPERCLIP_TRUST_PROXY PAPERCLIP_PORT PAPERCLIP_DATA_DIR
export OPENAI_API_KEY="${OPENAI_API_KEY:-}"
export ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}"

echo "==> docker compose (${COMPOSE_FILE})"

build_cmd=(docker compose -f "${COMPOSE_FILE}" --env-file "${ENV_FILE}" build)
if [[ -n "${DOCKER_BUILD_PLATFORM:-}" ]]; then
  build_cmd+=(--platform "${DOCKER_BUILD_PLATFORM}")
fi
if [[ -n "${NODE_MEMORY_MB:-}" ]]; then
  build_cmd+=(--build-arg "NODE_MEMORY_MB=${NODE_MEMORY_MB}")
fi

up_cmd=(
  docker compose -f "${COMPOSE_FILE}"
  --env-file "${ENV_FILE}"
  up -d --remove-orphans
)

if [[ -z "${SKIP_BUILD:-}" ]]; then
  "${build_cmd[@]}"
fi
"${up_cmd[@]}"

echo "==> Done."
echo "    Health (from this host — use 127.0.0.1; curl to the public IP on the same machine often fails):"
echo "      curl -fsS 'http://127.0.0.1:${PAPERCLIP_PORT}/api/health'"
echo "    From another machine (open firewall/tcp ${PAPERCLIP_PORT} first):"
echo "      curl -fsS '${PAPERCLIP_PUBLIC_URL}/api/health'"

if command -v curl >/dev/null 2>&1; then
  sleep 2
  if curl -fsS --connect-timeout 5 "http://127.0.0.1:${PAPERCLIP_PORT}/api/health" >/dev/null; then
    echo "==> Health OK (localhost:${PAPERCLIP_PORT})"
  else
    echo "==> Health check failed — try: docker compose -f ${COMPOSE_FILE} logs -f" >&2
  fi
fi
