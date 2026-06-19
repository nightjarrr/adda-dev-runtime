# Launcher–Container Contract

**Contract version:** 0.1.0

This specification defines the runtime interface between the host **launcher** and the AI harness **container** it runs. It governs only what crosses that boundary and is relied upon by the other side. For system goals and rationale, see the [conceptual design](adda-dev-runtime-design.md) and [technical design](adda-dev-runtime-technical-design.md).

The key words MUST, MUST NOT, SHALL, SHOULD, and MAY are to be interpreted as described in RFC 2119.

Versioning is semantic. The `0.x` series is unstable and MAY change incompatibly between minor versions while the contract is reduced toward its minimal form; `1.0.0` will mark the first stable contract, after which all versions within a major are backward-compatible. Before `1.0.0`, a launcher and container image interoperate only at the same minor version.

This version documents the **de facto** contract — the requirements the current container actually checks. Each requirement carries the container's behaviour when it is unmet:

- **Enforced** — the container aborts bootstrap (the launcher MUST satisfy it).
- **Expected** — the container warns but proceeds (the launcher SHOULD satisfy it).
- **Optional** — the launcher MAY provide it.

## 1. Launcher obligations

### 1.1 Environment

The launcher provides the following variables; the **Level** is the container's behaviour if a variable is absent:

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

Per mount, the requirements and the container's behaviour when each is unmet:

| Mount | Enforced | Expected |
|-------|----------|----------|
| `/workspace` | Exists, is accessible, is empty, and is writable by UID 1000. | Is a `tmpfs`, owned by UID 1000 / GID 1000, with execution permitted. |
| `/tmp` | Is writable by UID 1000. | Is a `tmpfs`, owned by UID 1000 / GID 1000, with execution permitted. |
| `/home/adda` | Is writable by UID 1000. | Is a `tmpfs`, owned by UID 1000 / GID 1000, with execution permitted. |
| `/run` | Is writable by UID 1000. | Is a `tmpfs`, owned by UID 1000 / GID 1000, mounted `noexec`. |
| Proxy socket at `ADDA_DEV_PROXY_SOCKET` | A socket exists at the path. | — |

### 1.3 Hardening

The launcher SHOULD run the container with `--cap-drop ALL`, `--security-opt no-new-privileges`, `--read-only`, and `--network none`. The container verifies each and warns, but proceeds. *(Expected)*

## 2. Container obligations

- The image SHALL run as user `adda` with UID 1000 and GID 1000, matching the ownership of the launcher-provided mounts.
- The image SHALL provide an executable at `/usr/local/libexec/adda-dev-runtime/bootstrap/open-interactive-shell.sh`, which the launcher runs via `docker exec` to open an interactive shell into the running container.
