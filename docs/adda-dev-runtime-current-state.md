# ADDA Dev Runtime — Current State / Handover

Purpose: dense implementation-state companion to `adda-dev-runtime.md`. The master doc describes target state. This file describes what is currently implemented, what is known to work, what is intentionally deferred, and what remains to do.

Audience: AI agent or maintainer continuing implementation.

---

## proto-adda — Tier 2 image

### What it is

`proto-adda` is the Tier 2 Docker image built `FROM adda-dev-runtime` (Tier 1). It adds:

* Node.js 24 LTS — installed as a direct binary from `nodejs.org` (no NodeSource, no `xz-utils`). Pinned via `NODE_VERSION` build arg / `ENV`.
* Claude Code — installed as a global npm package, version-pinned via `CLAUDE_CODE_VERSION` `ENV`.
* A bootstrap hook that applies the overlay and initialises Claude config at container start.
* `quality-gates.sh` baked at a fixed absolute path.

Build context must be the repo root (not `proto-adda/`) because `COPY` paths reference `proto-adda/...`:

```bash
docker build -f proto-adda/Dockerfile -t proto-adda:latest .
```

### Bootstrap hook mechanism

Tier 1's entrypoint sources every `*.sh` file under `/usr/local/libexec/adda-dev-runtime/entrypoint.d/` after BASE init and before CMD handoff. Tier 1 ships nothing there; `proto-adda` drops `10-claude-config.sh` via `Dockerfile COPY`.

Because hooks are sourced (not subprocessed), they can read and write environment variables that persist for downstream steps and the final CMD.

### Overlay semantics

The overlay is staged in the image at build time under `/usr/local/share/adda-dev-runtime/.claude/`. At container start, `10-claude-config.sh`:

1. Dies (non-silently) if `~/.claude/` already exists and is non-empty.
2. `cp -r`s the staged overlay to `~/.claude/`.
3. Stamps `~/.claude.json` from `/usr/local/share/adda-dev-runtime/templates/.claude.json.template`, substituting `__CLAUDE_CODE_VERSION__` with `$CLAUDE_CODE_VERSION`.
4. Creates `/workspace/.claude/memory`.

### Fixed paths

| Artifact | Absolute path in container |
|---|---|
| Claude Code binary | `$(which claude)` (npm global, resolved via `PATH`) |
| quality-gates.sh | `/usr/local/libexec/adda-dev-runtime/quality-gates.sh` |
| Overlay template dir | `/usr/local/share/adda-dev-runtime/.claude/` |
| `.claude.json` template | `/usr/local/share/adda-dev-runtime/templates/.claude.json.template` |
| Bootstrap hook | `/usr/local/libexec/adda-dev-runtime/entrypoint.d/10-claude-config.sh` |

---

## Current status summary

* The project has moved from the original in-container firewall design to a host/sidecar-enforced proxy design.
* ADDA Dev Runtime container now runs successfully with:

  * `--network none`
  * `--cap-drop ALL`
  * `--security-opt no-new-privileges`
  * `--read-only`
  * explicit tmpfs writable mounts
  * proxy egress via mounted Unix socket + in-container `socat` bridge
* Envoy sidecar runs as a separate container, outside the ADDA Dev Runtime container.
* Envoy currently works as a dynamic forward proxy over Unix domain socket.
* Envoy currently allows all destinations during dogfooding. Domain allow-list exists conceptually/configurationally but is not enforced yet.
* Current priority changed from completing all hardening/publishing/allow-list work to dogfooding the container early.
* GHCR publishing, digest pinning, full Envoy allow-list, and other target-state items remain deferred.

---

## Repository / branch context

* Target design doc: `docs/adda-dev-runtime.md`.
* Host launcher: `launcher/adda-dev.sh`.
* Launcher config: `launcher/adda-dev.env` (gitignored; from `adda-dev.env.example`).
* Tmux seed config: `launcher/adda-dev.tmux.conf`.
* ADDA Dev Runtime container Dockerfile: `docker/adda-dev-runtime/Dockerfile`.
* ADDA Dev Runtime container entrypoint: `docker/adda-dev-runtime/entrypoint.sh`.
* Envoy config template: `docker/envoy/envoy.yaml.template`.

---

## Runtime architecture actually implemented

* Launcher starts one Envoy sidecar container per Claude session.
* Launcher then starts one ADDA Dev Runtime container per Claude session.
* ADDA Dev Runtime container has no Docker network: `--network none`.
* Envoy sidecar has normal egress network and performs DNS/upstream connections.
* Envoy listens on a Unix socket in a launcher-created runtime directory.
* Launcher bind-mounts the Envoy socket into ADDA Dev Runtime container as `/run/proxy.sock`.
* Claude entrypoint starts `socat`:
  * listens on `127.0.0.1:${ADDA_DEV_PROXY_PORT}`
  * forwards to `/run/proxy.sock`
* Claude entrypoint exports:
  * `HTTP_PROXY=http://127.0.0.1:${ADDA_DEV_PROXY_PORT}`
  * `HTTPS_PROXY=http://127.0.0.1:${ADDA_DEV_PROXY_PORT}`
  * lowercase equivalents
  * `NO_PROXY=localhost,127.0.0.1,::1`
* Proxy-aware tools work through Envoy.
* Tools bypassing proxy env vars have no network path.

---

## Launcher current behavior

* Host prerequisites currently checked:
  * `docker`
  * `secret-tool`
  * `tmux`
  * `openssl`
* `adda-dev.env` is sourced and required variables validated.
* Launcher seeds `~/.tmux.conf` from `scripts/adda-dev.tmux.conf` only if missing.
* Launcher sources `~/.tmux.conf` best-effort; failures are warnings, not fatal.
* Launcher creates a named tmux session and re-enters itself inside it.
* `TMUX_SESSION` must be exported before re-entry; tmux window setup depends on this.
* Launcher retrieves secrets from keyring:
  * `service=adda-dev account=claude-oauth`
  * `service=adda-dev account=github-token`
* Launcher creates Envoy per-run runtime directory under `${XDG_RUNTIME_DIR:-/tmp}/adda-dev/${RUN_ID}`.
* Launcher renders Envoy config from `.devcontainer/envoy/envoy.yaml.template`.
* Launcher starts Envoy sidecar detached with `--rm`.
* Launcher does not publish Envoy admin to the host. Admin is accessible via `docker exec` using bash's built-in TCP (the Envoy image has no HTTP client tools and runs as non-root): `docker exec adda-dev-envoy-<RUN_ID> bash -c 'exec 3<>/dev/tcp/127.0.0.1/9901; printf "GET /ready HTTP/1.1\r\nHost: localhost\r\n\r\n" >&3; cat <&3'`
* Launcher waits for Envoy socket before starting ADDA Dev Runtime container.
* Launcher creates two additional windows in the primary tmux session: `adda-dev shell` (interactive bash into ADDA Dev Runtime container) and `adda-dev envoy logs` (`docker logs -f ${ENVOY_CONTAINER}`).
* Launcher starts ADDA Dev Runtime container interactively with `docker run --rm -it --name ${CLAUDE_CONTAINER}`.
* Launcher cleanup stops Envoy container and removes runtime dir on exit.

---

## Installed developer tooling

* Micro 2.0.15 — TUI text editor, static binary at `/usr/local/bin/micro`.
* delta 0.19.2 — syntax-highlighting git diff pager, static binary at `/usr/local/bin/delta`. Wired in via `/etc/gitconfig` (system-level): `core.pager`, `interactive.diffFilter`, `delta.line-numbers = true`, `delta.navigate = true`.
* `EDITOR=micro` and `VISUAL=micro` set via Dockerfile `ENV`; inherited by all container processes including non-interactive subshells.
* No Micro config is included; defaults are used. `~/.config/micro/` is not pre-populated (it would live on the ephemeral `/home/adda` tmpfs).

---

## ADDA Dev Runtime container current `docker run` shape

Current important flags:

* `--network none`
* `--cap-drop ALL`
* `--security-opt no-new-privileges`
* `--read-only`
* tmpfs mounts:

  * `/tmp`
  * `/run`
  * `/var/tmp`
  * `/home/${ADDA_DEV_USER}`
  * `/workspace`
* `/home/${ADDA_DEV_USER}` and `/workspace` require `exec` because `uv`/project tooling may execute from there.
* `/run` should remain `noexec`.
* Envoy socket is bind-mounted to `${ADDA_DEV_PROXY_SOCKET_CONTAINER_PATH}`, currently `/run/proxy.sock`.
* Socket mount is expected to sit on top of tmpfs-mounted `/run`.

Current observed working tmpfs constraints during testing:

* `/home/adda` tmpfs around 500M worked for current repo.
* `/workspace` tmpfs around 200M worked for current repo.
* `/tmp`, `/var/tmp`, `/run` small tmpfs mounts worked.
* Exact sizes should remain configurable; larger projects may require larger values.

---

## Envoy current behavior

* Envoy sidecar container starts. Admin interface is accessible via `docker exec` (not published to host).
* Envoy listens on Unix domain socket.
* Unix socket verified directly with `curl --unix-socket` during smoke test.
* `socat` TCP-to-UDS bridge verified on host and in ADDA Dev Runtime container.
* Envoy dynamic forward proxy config works for:

  * plain HTTP proxy requests
  * HTTPS `CONNECT` tunneling
* Envoy access logs work after adding access log flush config.
* Access log line formatting fixed by ensuring real newline, not literal `\n`.
* Useful access log fields:

  * start time
  * method
  * `:authority`
  * path
  * response code
  * response flags
  * upstream host
  * duration
* Envoy currently still uses allow-all RBAC or equivalent temporary policy for dogfooding.
* Envoy allow-list should later be enforced via RBAC `action: ALLOW` and no catch-all deny filter.
* Virtual host `domains: ["*"]` should remain; security policy belongs in RBAC, not route matching.

---

## Envoy allow-list design decisions made

* Use Envoy RBAC `action: ALLOW` for default-deny semantics.
* No explicit wildcard deny rule needed.
* Optional explicit deny-list only makes sense later for hard-block overrides before broad allow patterns.
* Policy match basis: `:authority`.
* For HTTPS `CONNECT`, authority usually includes `host:port`, e.g. `api.github.com:443`.
* For plain HTTP, authority may be `host` or `host:port`.
* Allow-list entries should account for both forms where needed.
* Dynamic forward proxy cluster remains appropriate; allow-list restricts it before DNS/upstream connection.
* DNS for upstreams happens in Envoy sidecar, not ADDA Dev Runtime container.

---

## Current known network domains

Observed/expected during bootstrap and runtime:

* GitHub / git / gh:
  * `github.com:443`
  * `api.github.com:443`
* Python / uv:
  * `releases.astral.sh:443`
  * `pypi.org:443`
  * `files.pythonhosted.org:443`
* Claude runtime likely:
  * `api.anthropic.com:443`
  * additional Claude Code runtime/telemetry domains may appear during real use

Policy clarification:
* OS/toolchain dependencies should be baked into image.
* Project dependencies are only knowable after runtime repo clone and may require registry access.
* Runtime registry access is allowed when explicit, ecosystem-specific, and frozen/lockfile based.
* Runtime APT/OS package installation is not allowed.

---

## Entrypoint current behavior

* Uses `set -euo pipefail` during bootstrap.
* Prints section headers, warnings, and green check success lines.
* Validates required env vars.
* Configures ephemeral Bash prompt in `$HOME/.bashrc`.
* Prompt includes repo and optional issue, e.g. `[adda-dev acme-repo #42] /workspace$`.
* Verifies `/workspace` is empty before clone.
* Runs warning/success diagnostics for:
  * network mode: loopback-only, no default route
  * capabilities: `CapEff=0000000000000000`
  * privileges: `NoNewPrivs=1`
  * read-only root
  * expected tmpfs mounts exist
  * expected tmpfs mounts writable by current user
  * writes outside approved mounts rejected
  * tmpfs ownership matches current UID/GID
  * `$HOME` and `/workspace` not `noexec`
  * `/run` is `noexec`
  * no unexpected writable non-tmpfs mounts
* Starts `socat` proxy bridge before any GitHub/git/uv network work.
* GitHub auth:
  * pipes `GITHUB_TOKEN_` (the launcher → container contract; trailing underscore avoids gh's reserved `GH_TOKEN`/`GITHUB_TOKEN` so no pre-unset dance) to `gh auth login --with-token --hostname github.com`
  * unsets `GITHUB_TOKEN_` after auth
  * exports `GH_REPO=${GITHUB_OWNER}/${GITHUB_REPO}` so subsequent gh calls (entrypoint and interactive) default to the project repo
  * runs `gh auth setup-git`
  * runs `gh auth status`
* Configures git author using GitHub API user id/login.
* Clones repo into `/workspace`.
* Resolves linked GitHub issue branch via GraphQL `linkedBranches(first: 2)`.
* Initializes `~/.claude.json` from template using `CLAUDE_CODE_VERSION`.
* `~/.claude/settings.json` ships via overlay (no separate template path); `autoMemoryDirectory` is set to `/workspace/.claude/memory`.
* Runs project bootstrap currently via `uv sync --frozen`.
* Runs CMD (`claude` by default), then drops to interactive bash.
* On exit, prints git status and commits ahead of upstream/main.

`.claude/memory/` is the in-repo auto memory directory. Memory files are committed to the current feature branch and merged to `main` via the normal PR lifecycle — the same lifecycle as subagent memory (`agent-memory/`).

---

## Tmux current behavior

* Launcher creates primary tmux session with three windows:

  * `adda-dev primary` — ADDA Dev Runtime container (`docker run`)
  * `adda-dev shell` — interactive `docker exec bash` into ADDA Dev Runtime container
  * `adda-dev envoy logs` — `docker logs -f ${ENVOY_CONTAINER}`
* `Ctrl-b d` detaches from tmux without killing underlying command.
* Tmux seed config is copied to `~/.tmux.conf` only if missing.
* Existing user `~/.tmux.conf` is never overwritten.
* Current tmux seed decisions:

  * mouse mode enabled
  * large scrollback
  * short `escape-time`
  * focus events
  * true color hints
  * clipboard/passthrough/title mutation disabled
  * slowed mouse-wheel scrolling via copy-mode bindings
  * `remain-on-exit failed` disabled due bad UX
* With mouse mode, terminal-native text selection may require Shift-drag.

---

## Hardening currently verified working

* `--network none` works.
* Proxy-aware tools still work via Envoy/socat.
* Proxy-bypass test works: unsetting proxy env vars causes `curl https://api.github.com` to fail with DNS/host resolution failure.
* `/sys/class/net` shows loopback-only in expected case.
* `--cap-drop ALL` works:

  * `CapEff: 0000000000000000`
* `--security-opt no-new-privileges` works:

  * `NoNewPrivs: 1`
* Read-only root works.
* Tmpfs mounts work after adding `exec` to `$HOME` and `/workspace`.
* `/run/proxy.sock` socket bind mount works on top of tmpfs `/run`.
* Docker-managed `/etc/hosts` appears as expected; not considered a hole.

---

## Current important config variables

Host/project launcher variables include at least:

* `GITHUB_OWNER`
* `GITHUB_REPO`
* `ENVOY_IMAGE`
* `ENVOY_SOCKET_CONTAINER_PATH`
* `ADDA_DEV_IMAGE`
* `ADDA_DEV_USER`
* `ADDA_DEV_UID`
* `ADDA_DEV_GID`
* `ADDA_DEV_HOME_TMPFS_SIZE`
* `ADDA_DEV_WORKSPACE_TMPFS_SIZE`
* `ADDA_DEV_PROXY_SOCKET_CONTAINER_PATH`
* `ADDA_DEV_PROXY_PORT`
* `ADDA_DEV_KEYRING_GITHUB_KEY`
* `ADDA_DEV_KEYRING_CLAUDE_KEY`
* `ADDA_DEV_KEYRING_DEEPSEEK_KEY`

---

## Current implementation intentionally not complete

This list is a starting point for future implementation plan:
* Enforce Envoy allow-list (currently allow-all for dogfooding).
* Implement GHCR image publishing.
* Implement Digest pinning.
* Implement Image provenance / scheduled rebuild workflow.
* Implement Image split into base and project.
* Implement Base/project split of entrypoint.
* Web Fetch / broad web research retrieval design.
* Design Live Envoy allow-list management/control plane.
* Design Credential-hiding via proxy/gateway.
* Consider Stronger isolation such as gVisor.
