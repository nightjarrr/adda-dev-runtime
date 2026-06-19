# Launcher–Container Contract

**Contract version:** 0.1.0

This specification defines the runtime interface between the host **launcher** and the AI harness **container** — the Tier 2 image the launcher runs. It governs only what crosses that boundary and is relied upon by the other side. For system goals and rationale, see the [conceptual design](adda-dev-runtime-design.md) and [technical design](adda-dev-runtime-technical-design.md).

The key words MUST, MUST NOT, SHALL, SHOULD, and MAY are to be interpreted as described in RFC 2119.

Versioning is semantic. The `0.x` series is unstable and MAY change incompatibly between minor versions while the contract is reduced toward its minimal form; `1.0.0` will mark the first stable contract, after which all versions within a major are backward-compatible. Before `1.0.0`, a launcher and container image interoperate only at the same minor version.

Each obligation carries an enforcement level describing what the container does when it is unmet:

- **Enforced** — the container aborts bootstrap.
- **Expected** — the container warns but proceeds.
- **Optional** — not required.

## 1. Launcher obligations

### 1.1 Environment

The launcher SHALL set the following variables on the container:

| Variable | Level | Meaning |
|----------|-------|---------|
| `GITHUB_OWNER` | Enforced | Repository owner. |
| `GITHUB_REPO` | Enforced | Repository name. |
| `GITHUB_TOKEN_` | Enforced | GitHub token. The trailing underscore is REQUIRED. |
| `TZ` | Enforced | Container timezone. |
| `ADDA_DEV_PROXY_SOCKET` | Enforced | Container path of the mounted proxy socket. |
| `ADDA_DEV_PROXY_PORT` | Enforced | Loopback TCP port for the in-container proxy bridge. |
| `ADDA_DEV_LLM_BACKEND` | Enforced | Harness backend: `anthropic` or `deepseek`. |
| `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` | Enforced | Set to `1`. |
| `ADDA_DEV_RUNTIME_IMAGE` | Optional | Image reference, for display only. |
| `ISSUE_ID` | Optional | GitHub issue number to resume. |

Backend credentials, selected by `ADDA_DEV_LLM_BACKEND`, are Enforced:

- `anthropic`: `CLAUDE_CODE_OAUTH_TOKEN`.
- `deepseek`: `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_OPUS_MODEL`, `ANTHROPIC_DEFAULT_SONNET_MODEL`, `ANTHROPIC_DEFAULT_HAIKU_MODEL`, `CLAUDE_CODE_SUBAGENT_MODEL`, `CLAUDE_CODE_EFFORT_LEVEL`.

### 1.2 Filesystem

- The launcher SHALL bind-mount the proxy socket read-only at the path given by `ADDA_DEV_PROXY_SOCKET`. *(Enforced)*
- `/workspace` SHALL be empty at container start. *(Enforced)*
- The launcher SHALL provide writable `tmpfs` mounts at `/tmp`, `/home/adda`, and `/workspace` permitting execution, and at `/run` with `noexec`, all owned by UID 1000, GID 1000. *(Expected)*

### 1.3 Hardening

The launcher SHALL run the container with `--cap-drop ALL`, `--security-opt no-new-privileges`, `--read-only`, and `--network none`. *(Expected)*

## 2. Container obligations

- The image SHALL run as user `adda` with UID 1000 and GID 1000, matching the ownership of the launcher-provided mounts.
- The image SHALL provide an executable at `/usr/local/libexec/adda-dev-runtime/bootstrap/open-interactive-shell.sh`, which the launcher runs via `docker exec` to open an interactive shell into the running container.
