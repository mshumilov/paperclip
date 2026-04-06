#!/usr/bin/env bash
# Deploy Paperclip to a remote host via SSH using a locally built image (no remote build).
#
# Target host is fixed in this script: root@108.174.78.157, SSH port 10220.
#
# If BETTER_AUTH_SECRET is unset, a secret is generated once and stored in
#   scripts/.server-yg.better-auth-secret (gitignored). Override with env to replace.
#
# If PAPERCLIP_PUBLIC_URL is unset, defaults to http://108.174.78.157:<PAPERCLIP_PORT>.
#
# The remote server is linux/amd64; Apple Silicon builds must target it explicitly.
#   DOCKER_BUILD_PLATFORM  default linux/amd64 (pass to docker build --platform)
#
# Common optional env:
#   BETTER_AUTH_SECRET
#   PAPERCLIP_PUBLIC_URL   e.g. https://paperclip.example.com
#   REMOTE_DIR          default /opt/yg/tools/agents
#   PAPERCLIP_IMAGE     default paperclip:remote
#   PAPERCLIP_PORT      host port, default 3100
#   PAPERCLIP_DATA_DIR  absolute path on server for /paperclip volume, default ${REMOTE_DIR}/data
#   OPENAI_API_KEY, ANTHROPIC_API_KEY
#   SKIP_BUILD=1        reuse existing local image tag (skip docker build)
#
# Example:
#   ./scripts/server-yg.sh
#   PAPERCLIP_PUBLIC_URL=https://paperclip.example.com ./scripts/server-yg.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

DEPLOY_SSH="root@108.174.78.157"
DEPLOY_SSH_PORT="10220"
DOCKER_BUILD_PLATFORM="${DOCKER_BUILD_PLATFORM:-linux/amd64}"
REMOTE_DIR="${REMOTE_DIR:-/opt/yg/tools/agents}"
PAPERCLIP_IMAGE="${PAPERCLIP_IMAGE:-paperclip:remote}"
PAPERCLIP_PORT="${PAPERCLIP_PORT:-3100}"
PAPERCLIP_DATA_DIR="${PAPERCLIP_DATA_DIR:-$REMOTE_DIR/data}"

SERVER_YG_SECRET_FILE="${REPO_ROOT}/scripts/.server-yg.better-auth-secret"
if [[ -z "${BETTER_AUTH_SECRET:-}" ]]; then
  if [[ -f "${SERVER_YG_SECRET_FILE}" ]]; then
    BETTER_AUTH_SECRET="$(tr -d '\n\r' < "${SERVER_YG_SECRET_FILE}")"
  else
    BETTER_AUTH_SECRET="$(openssl rand -hex 32)"
    umask 077
    printf '%s' "${BETTER_AUTH_SECRET}" > "${SERVER_YG_SECRET_FILE}"
    echo "==> Generated BETTER_AUTH_SECRET → ${SERVER_YG_SECRET_FILE} (keep private)" >&2
  fi
fi
PAPERCLIP_PUBLIC_URL="${PAPERCLIP_PUBLIC_URL:-http://108.174.78.157:${PAPERCLIP_PORT}}"

if [[ "${PAPERCLIP_DATA_DIR}" != /* ]]; then
  echo "PAPERCLIP_DATA_DIR must be an absolute path (got: ${PAPERCLIP_DATA_DIR})" >&2
  exit 1
fi

SSH=(ssh -p "${DEPLOY_SSH_PORT}" -o StrictHostKeyChecking=accept-new "${DEPLOY_SSH}")
SCP=(scp -P "${DEPLOY_SSH_PORT}" -o StrictHostKeyChecking=accept-new)

COMPOSE_SRC="${REPO_ROOT}/docker/docker-compose.remote-image.yml"

if [[ ! -f "${COMPOSE_SRC}" ]]; then
  echo "Missing ${COMPOSE_SRC}" >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "docker not found in PATH" >&2
  exit 1
fi

write_remote_env() {
  local out="$1"
  PAPERCLIP_IMAGE="${PAPERCLIP_IMAGE}" \
    BETTER_AUTH_SECRET="${BETTER_AUTH_SECRET}" \
    PAPERCLIP_PUBLIC_URL="${PAPERCLIP_PUBLIC_URL}" \
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
    "PAPERCLIP_IMAGE",
    "BETTER_AUTH_SECRET",
    "PAPERCLIP_PUBLIC_URL",
    "PAPERCLIP_PORT",
    "PAPERCLIP_DATA_DIR",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
]
lines = [f"{k}={esc(os.environ.get(k, ''))}" for k in keys]
out.write_text("\n".join(lines) + "\n", encoding="utf-8")
PY
}

echo "==> Build image (${PAPERCLIP_IMAGE}) for ${DOCKER_BUILD_PLATFORM}"
if [[ -z "${SKIP_BUILD:-}" ]]; then
  docker build --platform "${DOCKER_BUILD_PLATFORM}" -f "${REPO_ROOT}/Dockerfile" -t "${PAPERCLIP_IMAGE}" "${REPO_ROOT}"
else
  echo "    (SKIP_BUILD set — not rebuilding)"
fi

TMP_TAR="$(mktemp -t paperclip-docker.XXXXXX.tar)"
TMP_ENV="$(mktemp -t paperclip-remote.XXXXXX.env)"
cleanup() {
  rm -f "${TMP_TAR}" "${TMP_ENV}"
}
trap cleanup EXIT

echo "==> docker save → ${TMP_TAR}"
docker save "${PAPERCLIP_IMAGE}" -o "${TMP_TAR}"

write_remote_env "${TMP_ENV}"

echo "==> Prepare remote ${REMOTE_DIR}"
"${SSH[@]}" "mkdir -p '${REMOTE_DIR}' '${PAPERCLIP_DATA_DIR}'"

echo "==> Upload image tarball, compose, env"
"${SCP[@]}" "${TMP_TAR}" "${DEPLOY_SSH}:${REMOTE_DIR}/image.tar"
"${SCP[@]}" "${COMPOSE_SRC}" "${DEPLOY_SSH}:${REMOTE_DIR}/docker-compose.yml"
"${SCP[@]}" "${TMP_ENV}" "${DEPLOY_SSH}:${REMOTE_DIR}/.env"
"${SSH[@]}" "chmod 600 '${REMOTE_DIR}/.env'"

echo "==> docker load && compose up"
# shellcheck disable=SC2029
"${SSH[@]}" bash -s <<REMOTE
set -euo pipefail
cd $(printf '%q' "${REMOTE_DIR}")
docker load -i image.tar
rm -f image.tar
docker compose -f docker-compose.yml --env-file .env up -d --remove-orphans
docker image prune -f >/dev/null
REMOTE

echo "==> Done. Health check (from your machine, if URL is reachable):"
echo "    curl -fsS '${PAPERCLIP_PUBLIC_URL}/api/health'"
