#!/bin/bash
# ======================================================================
# adda-dev.sh — ADDA Dev Runtime launcher
#
# Single purpose: start the container.
# Reads project identity from adda-dev.env, retrieves auth tokens from
# the host Secret Service keyring, detects host timezone, and runs the
# dev environment image with an interactive TTY.
#
# Usage:
#   adda-dev.sh [--backend anthropic|deepseek] [<issue-id>] [-- <cmd> [args...]]
#   adda-dev.sh [--anthropic|--deepseek] [<issue-id>] [-- <cmd> [args...]]
#
# The default command is whatever the image's CMD specifies (claude).
# The override is intended for troubleshooting (e.g., running
# `uv run pytest` against a fresh clone without entering an interactive
# session).
#
# [TODO] Hardening flags, GHCR pull, digest pinning, entrypoint logic, and
# pre-exit reporting are added in later steps.
# ======================================================================

set -euo pipefail

# ----------------------------------------------------------------------
# Locate required directories and files
# ----------------------------------------------------------------------
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
SCRIPT_PATH="${SCRIPT_DIR}/$(basename "${BASH_SOURCE[0]}")"

ENV_FILE="${SCRIPT_DIR}/adda-dev.env"
ENVOY_TEMPLATE="${SCRIPT_DIR}/envoy.yaml.template"

TMUX_SEED_CONFIG="${SCRIPT_DIR}/adda-dev.tmux.conf"
TMUX_USER_CONFIG="${HOME}/.tmux.conf"

ORIGINAL_ARGS=("$@")

# ----------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------
die() {
    echo "Error: $*" >&2
    exit 1
}

warning() {
    printf '\033[1;33mWarning:\033[0m %s\n' "$*" >&2
}

usage() {
    cat >&2 <<EOF
Usage: adda-dev.sh [--backend anthropic|deepseek] [<issue-id>] [-- <cmd> [args...]]

Options:
  --backend BACKEND       Claude Code model backend: anthropic or deepseek.
                          Overrides ADDA_DEV_LLM_BACKEND from adda-dev.env.
  --backend=BACKEND       Same as --backend BACKEND.
  --anthropic             Shortcut for --backend anthropic.
  --deepseek              Shortcut for --backend deepseek.
  --no-tmux               Bypass tmux session management; run launcher inline.
                          Used internally for re-entry detection. Also useful for
                          debugging launcher or entrypoint failures.
  -h, --help              Show this help.

Arguments:
  <issue-id>              Optional. Positive integer GitHub Issue number to work on.
                          If omitted, the container starts without a specific Issue
                          context.
  -- <cmd>...             Optional. Override the image's default command.

Examples:
  adda-dev.sh
  adda-dev.sh 42
  adda-dev.sh --backend deepseek 42
  adda-dev.sh --deepseek -- ls -la /workspace
  adda-dev.sh 42 -- uv run pytest -q
EOF
}

require_tool() {
    local tool="$1"
    local hint="$2"
    if ! command -v "$tool" >/dev/null 2>&1; then
        die "required tool '$tool' not found in PATH. ${hint}"
    fi
}

require_var() {
    local var="$1"
    if [[ -z "${!var:-}" ]]; then
        die "required variable '${var}' is not set in ${ENV_FILE}."
    fi
}

quote_command() {
    printf '%q ' "$@"
}

validate_backend() {
  local backend="$1"

  case "$backend" in
    anthropic|deepseek)
      ;;
    *)
      die "unsupported backend '${backend}'. Supported backends: anthropic, deepseek."
      ;;
  esac
}

pull_if_not_local() {
    local image="$1"
    if [[ "$image" == *:local ]]; then return 0; fi
    echo "Pulling image: ${image}"
    docker pull "${image}"
}

# ----------------------------------------------------------------------
# Argument parsing
#
# Accepts, before '--':
#   options
#   zero or one positional issue ID
#
# Everything after '--' is command override and is not parsed as launcher
# syntax.
# ----------------------------------------------------------------------
ISSUE_ID=""
CLI_BACKEND=""
IS_NO_TMUX=0
CMD_OVERRIDE=()
POSITIONAL=()
SEPARATOR_FOUND=0

while [[ $# -gt 0 ]]; do
  arg="$1"
  shift

  if [[ "$SEPARATOR_FOUND" -eq 1 ]]; then
    CMD_OVERRIDE+=("$arg")
    continue
  fi

  case "$arg" in
    --)
      SEPARATOR_FOUND=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --backend)
      if [[ $# -eq 0 ]]; then
        usage
        die "--backend requires a value: anthropic or deepseek"
      fi
      CLI_BACKEND="$1"
      shift
      ;;
    --backend=*)
      CLI_BACKEND="${arg#--backend=}"
      if [[ -z "$CLI_BACKEND" ]]; then
        usage
        die "--backend requires a value: anthropic or deepseek"
      fi
      ;;
    --anthropic)
      CLI_BACKEND="anthropic"
      ;;
    --deepseek)
      CLI_BACKEND="deepseek"
      ;;
    --no-tmux)
      IS_NO_TMUX=1
      ;;
    --*)
      usage
      die "unknown option '${arg}'"
      ;;
    *)
      POSITIONAL+=("$arg")
      ;;
  esac
done

# If the separator was given, a command must follow it.
if [[ "$SEPARATOR_FOUND" -eq 1 ]] && [[ ${#CMD_OVERRIDE[@]} -eq 0 ]]; then
    usage
    die "'--' was given but no command followed it"
fi

# Positional args before '--' carry the optional issue ID. Zero or one,
# nothing else.
if [[ ${#POSITIONAL[@]} -gt 1 ]]; then
    usage
    die "expected at most one positional argument before '--', got ${#POSITIONAL[@]}"
fi

if [[ ${#POSITIONAL[@]} -eq 1 ]]; then
    if [[ ! "${POSITIONAL[0]}" =~ ^[1-9][0-9]*$ ]]; then
        usage
        die "issue ID must be a positive integer, got '${POSITIONAL[0]}'"
    fi
    ISSUE_ID="${POSITIONAL[0]}"
fi

if [[ -n "$CLI_BACKEND" ]]; then
  validate_backend "$CLI_BACKEND"
fi

# ----------------------------------------------------------------------
# Prerequisite tool checks
# ----------------------------------------------------------------------
require_tool docker      "Install Docker Engine (https://docs.docker.com/engine/install/)."
require_tool secret-tool "Install libsecret-tools (apt install libsecret-tools)."
require_tool tmux        "Install tmux (apt install tmux)."
require_tool openssl     "Install OpenSSL (apt install openssl)."

# ----------------------------------------------------------------------
# Load and validate adda-dev.env
# ----------------------------------------------------------------------
if [[ ! -f "$ENV_FILE" ]]; then
    die "adda-dev.env not found at ${ENV_FILE}. See adda-dev-runtime.md for required contents."
fi

# shellcheck disable=SC1090
source "$ENV_FILE"

require_var GITHUB_OWNER
require_var GITHUB_REPO

require_var ADDA_DEV_IMAGE
require_var ADDA_DEV_USER
require_var ADDA_DEV_UID
require_var ADDA_DEV_GID
require_var ADDA_DEV_HOME_TMPFS_SIZE
require_var ADDA_DEV_WORKSPACE_TMPFS_SIZE
require_var ADDA_DEV_PROXY_SOCKET_CONTAINER_PATH
require_var ADDA_DEV_PROXY_PORT

require_var ENVOY_IMAGE
require_var ENVOY_SOCKET_CONTAINER_PATH

require_var ADDA_DEV_KEYRING_GITHUB_KEY
require_var ADDA_DEV_KEYRING_CLAUDE_KEY
require_var ADDA_DEV_KEYRING_DEEPSEEK_KEY

# Backend resolution order:
#   1. explicit CLI option
#   2. adda-dev.env / inherited environment
#   3. built-in default
ADDA_DEV_LLM_BACKEND="${CLI_BACKEND:-${ADDA_DEV_LLM_BACKEND:-anthropic}}"
validate_backend "$ADDA_DEV_LLM_BACKEND"

# Disable Claude Code's nonessential traffic for both Anthropic and
# DeepSeek backends. Keep it here instead of in adda-dev.env so the
# security posture does not depend on project-local config drift.
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1

export GITHUB_OWNER GITHUB_REPO ADDA_DEV_LLM_BACKEND CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC

# ----------------------------------------------------------------------
# If not already inside tmux, re-enter this launcher inside a tmux session.
# ----------------------------------------------------------------------

ensure_tmux_config() {
    if [[ -z "${HOME:-}" ]]; then
        warning "HOME is not set; cannot determine ~/.tmux.conf location. Continuing with tmux defaults."
        return 0
    fi

    if [[ -f "$TMUX_USER_CONFIG" ]]; then
        echo "tmux config: ${TMUX_USER_CONFIG} exists; using it as-is, no modifications applied."
    else
        if [[ ! -f "$TMUX_SEED_CONFIG" ]]; then
            warning "tmux seed config not found at ${TMUX_SEED_CONFIG}; continuing with tmux defaults."
            return 0
        fi

        echo "tmux config: ${TMUX_USER_CONFIG} not found; seeding from ${TMUX_SEED_CONFIG}."

        # # Do not chmod ~/.tmux.conf after copying.
        # Let cp + user's umask determine permissions.
        if ! cp "$TMUX_SEED_CONFIG" "$TMUX_USER_CONFIG"; then
            warning "failed to copy tmux seed config to ${TMUX_USER_CONFIG}; continuing with tmux defaults."
            return 0
        fi
    fi

    # If a default tmux server already exists, it has already loaded its
    # startup config. Try to source ~/.tmux.conf explicitly. Failure is not
    # fatal because tmux configuration is only a UX enhancement.
    local source_output
    if source_output="$(tmux source-file "$TMUX_USER_CONFIG" 2>&1)"; then
        echo "tmux config: sourced into existing tmux server."
    else
        if grep -qi "no server running" <<<"$source_output"; then
            echo "tmux config: no existing tmux server; config will be loaded when tmux starts."
        else
            warning "failed to source tmux config ${TMUX_USER_CONFIG}; continuing."
            if [[ -n "$source_output" ]]; then
                printf '%s\n' "$source_output" | sed 's/^/  tmux: /' >&2
            fi
        fi
    fi
}

if [[ "$IS_NO_TMUX" -eq 0 ]]; then
    SUFFIX="$(openssl rand -hex 2)"
    if [[ -n "$ISSUE_ID" ]]; then
        TMUX_SESSION="${GITHUB_OWNER}-${GITHUB_REPO}-${ISSUE_ID}-${SUFFIX}"
    else
        TMUX_SESSION="${GITHUB_OWNER}-${GITHUB_REPO}-${SUFFIX}"
    fi
    export TMUX_SESSION
    echo "tmux session: ${TMUX_SESSION}"

    TMUX_COMMAND="$(quote_command "$SCRIPT_PATH" "--no-tmux" "${ORIGINAL_ARGS[@]}")"

    if [[ -z "${TMUX:-}" ]]; then
        ensure_tmux_config
        exec tmux new-session -s "${TMUX_SESSION}" \
            -e "TMUX_SESSION=${TMUX_SESSION}" \
            -n "adda-dev primary" "${TMUX_COMMAND}"
    else
        tmux new-session -d -s "${TMUX_SESSION}" \
            -e "TMUX_SESSION=${TMUX_SESSION}" \
            -n "adda-dev primary" "${TMUX_COMMAND}"
        exec tmux switch-client -t "${TMUX_SESSION}"
    fi
fi

# ----------------------------------------------------------------------
# Retrieve auth tokens from the host Secret Service keyring
# ----------------------------------------------------------------------
keyring_lookup() {
    local account="$1"
    local key="$2"
    local value
    value="$(secret-tool lookup service adda-dev account "$account" key "$key" || true)"
    if [[ -z "$value" ]]; then
        die "no secret found in keyring for service=adda-dev account=${account} key=${key}. See adda-dev-runtime.md for the bootstrap procedure."
    fi
    printf '%s' "$value"
}

GITHUB_TOKEN_="$(keyring_lookup github "$ADDA_DEV_KEYRING_GITHUB_KEY")"
export GITHUB_TOKEN_

BACKEND_DOCKER_ENV=()
case "$ADDA_DEV_LLM_BACKEND" in
  anthropic)
    CLAUDE_CODE_OAUTH_TOKEN="$(keyring_lookup claude "$ADDA_DEV_KEYRING_CLAUDE_KEY")"
    export CLAUDE_CODE_OAUTH_TOKEN
    BACKEND_DOCKER_ENV=(
      -e CLAUDE_CODE_OAUTH_TOKEN
    )
    ;;

  deepseek)
    ANTHROPIC_AUTH_TOKEN="$(keyring_lookup deepseek "$ADDA_DEV_KEYRING_DEEPSEEK_KEY")"

    ANTHROPIC_BASE_URL="${ADDA_DEV_DEEPSEEK_BASE_URL:-https://api.deepseek.com/anthropic}"
    ANTHROPIC_MODEL="${ADDA_DEV_DEEPSEEK_MODEL:-deepseek-v4-flash}"
    ANTHROPIC_DEFAULT_OPUS_MODEL="${ADDA_DEV_DEEPSEEK_OPUS_MODEL:-deepseek-v4-pro[1m]}"
    ANTHROPIC_DEFAULT_SONNET_MODEL="${ADDA_DEV_DEEPSEEK_SONNET_MODEL:-deepseek-v4-pro[1m]}"
    ANTHROPIC_DEFAULT_HAIKU_MODEL="${ADDA_DEV_DEEPSEEK_HAIKU_MODEL:-deepseek-v4-flash}"
    CLAUDE_CODE_SUBAGENT_MODEL="${ADDA_DEV_DEEPSEEK_SUBAGENT_MODEL:-deepseek-v4-flash}"
    CLAUDE_CODE_EFFORT_LEVEL="${ADDA_DEV_DEEPSEEK_EFFORT_LEVEL:-max}"

    export \
      ANTHROPIC_AUTH_TOKEN \
      ANTHROPIC_BASE_URL \
      ANTHROPIC_MODEL \
      ANTHROPIC_DEFAULT_OPUS_MODEL \
      ANTHROPIC_DEFAULT_SONNET_MODEL \
      ANTHROPIC_DEFAULT_HAIKU_MODEL \
      CLAUDE_CODE_SUBAGENT_MODEL \
      CLAUDE_CODE_EFFORT_LEVEL

    BACKEND_DOCKER_ENV=(
      -e ANTHROPIC_BASE_URL
      -e ANTHROPIC_AUTH_TOKEN
      -e ANTHROPIC_MODEL
      -e ANTHROPIC_DEFAULT_OPUS_MODEL
      -e ANTHROPIC_DEFAULT_SONNET_MODEL
      -e ANTHROPIC_DEFAULT_HAIKU_MODEL
      -e CLAUDE_CODE_SUBAGENT_MODEL
      -e CLAUDE_CODE_EFFORT_LEVEL
    )
    ;;

  *)
    # validate_backend should make this unreachable.
    die "unsupported backend '${ADDA_DEV_LLM_BACKEND}'"
    ;;
esac

# ----------------------------------------------------------------------
# Detect host timezone
# ----------------------------------------------------------------------
detect_host_tz() {
    if [[ -f /etc/timezone ]]; then
        cat /etc/timezone
    elif [[ -L /etc/localtime ]]; then
        readlink -f /etc/localtime | sed 's|.*/zoneinfo/||'
    else
        echo "UTC"
    fi
}

TZ="$(detect_host_tz)"
export TZ

# ----------------------------------------------------------------------
# Runtime initialization
# ----------------------------------------------------------------------
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$(openssl rand -hex 8)"
RUN_BASE="${XDG_RUNTIME_DIR:-/tmp}/adda-dev"
RUN_DIR="${RUN_BASE}/${RUN_ID}"

# ----------------------------------------------------------------------
# Envoy sidecar runtime setup
# ----------------------------------------------------------------------
ENVOY_CONTAINER="adda-dev-envoy-${RUN_ID}"
ENVOY_RUNTIME_CONFIG="${RUN_DIR}/envoy.yaml"

cleanup_envoy() {
    local status=$?
    trap - EXIT INT TERM

    if [[ -n "${ENVOY_CONTAINER:-}" ]]; then
        docker stop "${ENVOY_CONTAINER}" >/dev/null 2>&1 || true
    fi

    if [[ -n "${RUN_DIR:-}" ]]; then
        rm -rf "${RUN_DIR}" >/dev/null 2>&1 || true
    fi

    exit "$status"
}

trap cleanup_envoy EXIT INT TERM

prepare_envoy() {
    if [[ ! -f "$ENVOY_TEMPLATE" ]]; then
        die "Envoy config template not found at ${ENVOY_TEMPLATE}"
    fi

    mkdir -p "$RUN_DIR"
    chmod 700 "$RUN_DIR"

    sed \
        -e "s|__ENVOY_SOCKET_PATH__|${ENVOY_SOCKET_CONTAINER_PATH}|g" \
        "$ENVOY_TEMPLATE" > "$ENVOY_RUNTIME_CONFIG"

    chmod 600 "$ENVOY_RUNTIME_CONFIG"
}

start_envoy() {
    prepare_envoy

    pull_if_not_local "${ENVOY_IMAGE}"

    echo "Starting Envoy proxy sidecar: ${ENVOY_CONTAINER}"

    docker run --rm -d \
        --name "${ENVOY_CONTAINER}" \
        --user "$(id -u):$(id -g)" \
        --cap-drop ALL \
        --security-opt no-new-privileges \
        --read-only \
        --tmpfs /tmp:rw,nosuid,nodev,noexec,size=16m \
        -v "${RUN_DIR}:/run/adda-dev-proxy:rw" \
        "${ENVOY_IMAGE}" \
        -c /run/adda-dev-proxy/envoy.yaml
}

# Envoy socket on host system
ENVOY_SOCKET_HOST_PATH="${RUN_DIR}/$(basename "$ENVOY_SOCKET_CONTAINER_PATH")"

wait_for_envoy() {
    for _ in {1..100}; do
        if [[ -S "$ENVOY_SOCKET_HOST_PATH" ]]; then
            echo "Envoy proxy socket ready: ${ENVOY_SOCKET_HOST_PATH}"
            return 0
        fi

        if ! docker inspect -f '{{.State.Running}}' "${ENVOY_CONTAINER}" >/dev/null 2>&1; then
            docker logs "${ENVOY_CONTAINER}" >&2 || true
            die "Envoy container exited before creating proxy socket"
        fi

        sleep 0.1
    done

    docker logs "${ENVOY_CONTAINER}" >&2 || true
    die "Envoy did not create proxy socket at ${ENVOY_SOCKET_HOST_PATH}"
}

# ----------------------------------------------------------------------
# Tmux window setup
# ----------------------------------------------------------------------
ADDA_DEV_CONTAINER="adda-dev-${RUN_ID}"

setup_tmux_windows() {
    if [[ -z "${TMUX_SESSION:-}" ]]; then
        warning "TMUX_SESSION is not set; additional tmux windows not created."
        return 0
    fi

    if ! tmux new-window -t "${TMUX_SESSION}" -n "adda-dev shell" \
        "c=0; until docker inspect -f '{{.State.Running}}' ${ADDA_DEV_CONTAINER} 2>/dev/null | grep -q true; do sleep 1; c=\$((c+1)); if [[ \$c -ge 30 ]]; then echo 'Timed out waiting for Claude container'; exit 1; fi; done; docker exec -it ${ADDA_DEV_CONTAINER} /usr/local/libexec/adda-dev-runtime/bootstrap/open-interactive-shell.sh"; then
        warning "failed to create 'adda-dev shell' tmux window; to open manually: tmux new-window -t '${TMUX_SESSION}' -n 'adda-dev shell' 'docker exec -it ${ADDA_DEV_CONTAINER} /usr/local/libexec/adda-dev-runtime/bootstrap/open-interactive-shell.sh'"
    fi

    if ! tmux new-window -t "${TMUX_SESSION}" -n "adda-dev envoy logs" \
        "docker logs -f ${ENVOY_CONTAINER}"; then
        warning "failed to create 'adda-dev envoy logs' tmux window; to open manually: tmux new-window -t '${TMUX_SESSION}' -n 'adda-dev envoy logs' 'docker logs -f ${ENVOY_CONTAINER}'"
    fi

    tmux select-window -t "${TMUX_SESSION}:adda-dev primary" || \
        warning "failed to select primary tmux window; continuing."
}

# ----------------------------------------------------------------------
# Build dev container docker run argument list
# ----------------------------------------------------------------------
DOCKER_ARGS=(
  run --rm -it
  --name "${ADDA_DEV_CONTAINER}"

  -e GITHUB_OWNER
  -e GITHUB_REPO
  -e GITHUB_TOKEN_
  -e TZ
  -e ADDA_DEV_LLM_BACKEND
  -e CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC
  -e "ADDA_DEV_RUNTIME_IMAGE=${ADDA_DEV_IMAGE}"
  "${BACKEND_DOCKER_ENV[@]}"

  # Capability and privilege restrictions.
  --cap-drop ALL
  --security-opt no-new-privileges

  # Read-only root and tmpfs mounts.
  --read-only
  --tmpfs "/tmp:rw,exec,nosuid,nodev,size=64m,mode=700,uid=${ADDA_DEV_UID},gid=${ADDA_DEV_GID}"
  --tmpfs "/run:rw,nosuid,nodev,noexec,size=32m,mode=700,uid=${ADDA_DEV_UID},gid=${ADDA_DEV_GID}"
  --tmpfs "/var/tmp:rw,nosuid,nodev,size=64m,mode=700,uid=${ADDA_DEV_UID},gid=${ADDA_DEV_GID}"
  --tmpfs "/home/${ADDA_DEV_USER}:rw,exec,nosuid,nodev,size=${ADDA_DEV_HOME_TMPFS_SIZE},mode=700,uid=${ADDA_DEV_UID},gid=${ADDA_DEV_GID}"
  --tmpfs "/workspace:rw,exec,nosuid,nodev,size=${ADDA_DEV_WORKSPACE_TMPFS_SIZE},mode=700,uid=${ADDA_DEV_UID},gid=${ADDA_DEV_GID}"

  # Network isolation and proxy config.
  --network none

  # This socket mount is expected to happen atop the tmpfs-mounted /run in
  # the container.
  --mount "type=bind,source=${ENVOY_SOCKET_HOST_PATH},target=${ADDA_DEV_PROXY_SOCKET_CONTAINER_PATH},readonly"
  -e "ADDA_DEV_PROXY_SOCKET=${ADDA_DEV_PROXY_SOCKET_CONTAINER_PATH}"
  -e "ADDA_DEV_PROXY_PORT=${ADDA_DEV_PROXY_PORT}"
)

if [[ -n "$ISSUE_ID" ]]; then
    export ISSUE_ID
    DOCKER_ARGS+=(-e ISSUE_ID)
fi

DOCKER_ARGS+=("${ADDA_DEV_IMAGE}")

# If a command override was given, append it after the image reference.
# Docker passes everything after the image to the container's CMD, which
# the entrypoint exec's via "$@".
if [[ ${#CMD_OVERRIDE[@]} -gt 0 ]]; then
    DOCKER_ARGS+=("${CMD_OVERRIDE[@]}")
fi

# ----------------------------------------------------------------------
# Run
# ----------------------------------------------------------------------
start_envoy
wait_for_envoy
setup_tmux_windows

pull_if_not_local "${ADDA_DEV_IMAGE}"

echo "Starting ADDA Dev Runtime container..."
docker "${DOCKER_ARGS[@]}"
