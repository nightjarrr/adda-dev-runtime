# Launcher–Container Contract

**Contract version:** 0.1.0

This specification defines the runtime interface between the host **launcher** and the AI harness **container**. It governs only what crosses that boundary and is relied upon by the other side.

Versioning is semantic. The `0.x` series is unstable and MAY change incompatibly between minor versions while the contract is reduced toward its minimal form; `1.0.0` will mark the first stable contract, after which all versions within a major are backward-compatible. Before `1.0.0`, a launcher and container image interoperate only at the same minor version.

The key words MUST, MUST NOT, SHALL, SHOULD, and MAY are to be interpreted as described in RFC 2119.

## 1. Launcher obligations

### 1.1 Environment

The launcher SHALL pass the following variables to the container:

| Variable | Presence | Meaning |
|----------|----------|---------|
| `GITHUB_OWNER` | MUST | Repository owner. |
| `GITHUB_REPO` | MUST | Repository name. |
| `GITHUB_TOKEN_` | MUST | GitHub token. The trailing underscore is REQUIRED. |
| `TZ` | MUST | Container timezone. |
| `ADDA_DEV_LLM_BACKEND` | MUST | Harness backend: `anthropic` or `deepseek`. |
| `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` | MUST | Set to `1`. |
| `ADDA_DEV_PROXY_SOCKET` | MUST | Container path of the mounted proxy socket. |
| `ADDA_DEV_PROXY_PORT` | MUST | Loopback TCP port for the in-container proxy bridge. |
| Backend credentials | MUST | `anthropic`: `CLAUDE_CODE_OAUTH_TOKEN`. `deepseek`: `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_BASE_URL`. |
| `ADDA_DEV_RUNTIME_IMAGE` | MAY | Image reference, for display only. |
| `ISSUE_ID` | MAY | GitHub issue number to resume. |

### 1.2 Filesystem

- The launcher SHALL provide writable `tmpfs` mounts at `/tmp`, `/home/adda`, and `/workspace` permitting execution, and at `/run` with `noexec`.
- All four mounts SHALL be owned by UID 1000, GID 1000.
- `/workspace` SHALL be empty at container start.
- The launcher SHALL bind-mount the proxy socket read-only at the path given by `ADDA_DEV_PROXY_SOCKET`.

### 1.3 Hardening

The launcher SHALL run the container with `--cap-drop ALL`, `--security-opt no-new-privileges`, `--read-only`, and `--network none`.

## 2. Container obligations

- The image SHALL run as user `adda` with UID 1000 and GID 1000.
- The ENTRYPOINT SHALL execute the supplied command vector, and SHALL run the default harness when none is supplied.
- The image SHALL consume `GITHUB_TOKEN_` to establish GitHub authentication.
- The image SHALL provide an executable at `/usr/local/libexec/adda-dev-runtime/bootstrap/open-interactive-shell.sh`.
