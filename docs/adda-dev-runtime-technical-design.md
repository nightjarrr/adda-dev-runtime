# ADDA Dev Runtime — Technical Design

This document is the technical complement to [`docs/adda-dev-runtime-design.md`](adda-dev-runtime-design.md). It describes the concrete implementation of the design established there — entrypoint sequence, configuration variables, network enforcement, authentication, artifact routing, and image build pipeline.

**Audience: human Project Owner only.** Read when implementing, extending, or debugging the runtime. Not part of any agent's runtime context.

Throughout, `{owner}` and `{repo}` refer to the GitHub namespace and repository name of the project.

---

## Host prerequisites

Linux only, tested on Ubuntu 24.04.

Required:

* Docker Engine or compatible OCI runtime. Desktop is not required.
* Bash.
* `openssl` command-line utility — used by the launcher for random run/session identifiers.
* Ghostty, or another modern terminal emulator.
* `tmux` — used for survivable terminal sessions.
* `libsecret-tools` — provides `secret-tool` for keyring access.
* `seahorse` — optional but recommended for GUI keyring inspection.
* An active GNOME, KDE, or compatible Secret Service login session, so the keyring is unlocked.

Notably **not** required on the host: `git`, `gh`, the AI harness CLI, Python, Node, uv, or any project-specific runtime tooling. Those live inside containers.

---

## Launcher

Host-side script (`adda-dev.sh`). Creates one ephemeral AI harness dev runtime per invocation.

Invocation:

```bash
adda-dev.sh
adda-dev.sh <issue-id>
adda-dev.sh -- <cmd> [args...]
adda-dev.sh <issue-id> -- <cmd> [args...]
```

### Per-project configuration

The launcher reads `adda-dev.env` from the same directory as the launcher script.

Required variables:

```bash
# Github repo
GITHUB_OWNER=
GITHUB_REPO=

# ADDA Dev Runtime container image configuration
ADDA_DEV_IMAGE=
ADDA_DEV_USER=adda
ADDA_DEV_UID=1000
ADDA_DEV_GID=1000
ADDA_DEV_HOME_TMPFS_SIZE=500m
ADDA_DEV_WORKSPACE_TMPFS_SIZE=200m
# Needs to be a file directly in /run to support the /run tmpfs
ADDA_DEV_PROXY_SOCKET_CONTAINER_PATH=/run/proxy.sock
ADDA_DEV_PROXY_PORT=8080

# Envoy perimeter sidecar configuration
ENVOY_IMAGE=envoyproxy/envoy:v1.33.14
ENVOY_SOCKET_CONTAINER_PATH=/run/adda-dev-proxy/proxy.sock
```

### Behavior

1. Validate arguments.
2. Verify host prerequisites: `docker`, `secret-tool`, `tmux`, `openssl`.
3. Source `adda-dev.env` and validate required variables.
4. Seed `~/.tmux.conf` from `scripts/adda-dev.tmux.conf` only if missing; source it best-effort.
5. If not already inside tmux, generate a session name, export it, and re-enter the launcher inside a named tmux session.
6. Retrieve auth tokens from the Secret Service keyring. See *Authentication*.
7. Detect host timezone.
8. Create a private per-run runtime directory under `${XDG_RUNTIME_DIR:-/tmp}`.
9. Render Envoy config from `envoy.yaml.template`, co-located with the launcher script, into the runtime directory.
10. Start Envoy sidecar container with hardened flags. See *Envoy sidecar*.
11. Wait for the Envoy Unix socket.
12. Create `adda-dev shell` and `adda-dev envoy logs` windows in the primary tmux session. The `adda-dev shell` window invokes a container-side script that waits for bootstrap to finish before opening the interactive bash prompt.
13. Assemble and run the AI harness container. See *Filesystem and process hardening* for flags and *Network* for proxy wiring.
14. On exit, stop Envoy and remove the runtime directory.

### tmux and terminal emulator

The launcher creates a named host tmux session and re-enters itself inside that session. This keeps the launcher, Envoy lifecycle, and `docker run` under tmux control. If the terminal emulator crashes or closes, the tmux server keeps the session alive. Reattach using the printed tmux session name.

The launcher seeds `~/.tmux.conf` from `scripts/adda-dev.tmux.conf` only when `~/.tmux.conf` is absent. Existing user tmux config is never overwritten.

Recommended seed behavior: large scrollback; mouse mode enabled; slower mouse-wheel scrolling in copy mode; short escape-time for responsive TUIs; focus events enabled; true-color terminal features; clipboard/passthrough/title mutation disabled for safety; no `remain-on-exit failed` default.

With tmux mouse mode enabled, normal terminal selection may require Shift-drag depending on terminal emulator.

Common tmux actions:

```text
Ctrl-b d     detach from session
Ctrl-b [     enter copy mode
Ctrl-b x     kill pane
```

Ghostty is the preferred terminal emulator. Increase host terminal scrollback if desired:

```text
scrollback-limit = 100000000
```

---

## Envoy sidecar

Runs as a separate container managed by the launcher. Not inside the AI harness container. Per-session: one AI harness container gets one Envoy sidecar.

Hardening flags:

* `--rm -d`
* `--cap-drop ALL`
* `--security-opt no-new-privileges`
* read-only root where compatible
* tmpfs for `/tmp`
* admin interface not published to host; accessible via `docker exec` only

See *Network* for Envoy's policy responsibilities.

### Admin interface

Bound to container loopback (`127.0.0.1:9901`). Not published to any host port — parallel Envoy sidecars coexist without port conflicts.

Access via `docker exec` into the named Envoy container. The Envoy image does not include HTTP client tools; use bash's built-in TCP support (HTTP/1.1 required — Envoy rejects HTTP/1.0):

```bash
docker exec adda-dev-envoy-<RUN_ID> bash -c \
  'exec 3<>/dev/tcp/127.0.0.1/9901
   printf "GET /ready HTTP/1.1\r\nHost: localhost\r\n\r\n" >&3
   cat <&3'
```

Replace `/ready` with `/stats`, `/listeners`, `/clusters`, or `/config_dump` for other diagnostic endpoints.

The admin interface is for diagnostics only. It is not a policy editing UI and must not be exposed to untrusted networks.

---

## Network

The complete network story spans three components: the launcher (starts Envoy), the Envoy sidecar (enforces policy), and the entrypoint (starts the in-container proxy bridge). This section describes all three together.

### Container networking

The AI harness container is launched with `--network none`.

Expected properties inside the container:
* Only loopback is available.
* There is no default route.
* Direct DNS resolution to internet resolvers is unavailable.
* Direct TCP connections to internet IPs fail.
* Tools that ignore proxy settings fail to reach the network.

### Proxy bridge

Most applications understand HTTP proxies as `host:port`, not Unix sockets. The entrypoint starts a `socat` bridge inside the container:

```text
127.0.0.1:<ADDA_DEV_PROXY_PORT>  ->  <ADDA_DEV_PROXY_SOCKET>
```

The entrypoint then exports:

```bash
HTTP_PROXY=http://127.0.0.1:<port>
HTTPS_PROXY=http://127.0.0.1:<port>
http_proxy=http://127.0.0.1:<port>
https_proxy=http://127.0.0.1:<port>
NO_PROXY=localhost,127.0.0.1,::1
no_proxy=localhost,127.0.0.1,::1
```

For HTTPS destinations, clients send HTTP `CONNECT` to Envoy. Envoy sees the target authority (e.g. `api.github.com:443`) but does not decrypt TLS in the baseline design.

### Envoy policy

Envoy responsibilities:
* Accept explicit HTTP proxy traffic on the Unix socket.
* Support plain HTTP forwarding and HTTPS `CONNECT` tunneling.
* Enforce domain allow-list / default-deny policy using RBAC.
* Resolve allowed upstream domains.
* Emit access logs for audit/debugging.

Default-deny is achieved via Envoy RBAC `action: ALLOW` — no explicit wildcard deny rule is needed; a request that matches no policy entry is denied automatically.

Policy match basis is `:authority`. For HTTPS `CONNECT`, authority is `host:port` (e.g. `api.github.com:443`); for plain HTTP, authority may be `host` or `host:port` — allow-list entries must account for both forms.

### DNS

The AI harness container does not resolve internet destinations for proxied traffic — it only connects to loopback. Envoy receives the requested authority from the explicit proxy request and resolves allowed destinations from the sidecar container. Policy is applied before DNS resolution and before upstream connection.

### Allow-list

Target-state allow-list is default-deny. Requests are allowed only if the requested authority matches an explicit policy.

Baseline target destinations:

| Destination | Why |
|---|---|
| `api.anthropic.com` | Claude Code API calls. |
| `claude.ai` | Claude Code auth/runtime flows where required. |
| `statsig.anthropic.com` | Claude Code telemetry / feature gates, if required. |
| `sentry.io` | Claude Code error reporting, if required. |
| `github.com` | Git over HTTPS, web endpoint dependencies. |
| `api.github.com` | GitHub CLI issue, PR, label, branch linkage, and account API calls. |
| `raw.githubusercontent.com` | Raw repository content where required. |
| `objects.githubusercontent.com` | GitHub release assets and Git LFS objects where required. |
| narrowly scoped `githubusercontent.com` hosts | GitHub-hosted raw/assets content where required. |

Runtime package-registry access:
- Container/toolchain dependencies are baked into the image and do not require runtime package-manager access.
- Project code dependencies may require runtime registry access. Registry access must be explicit, ecosystem-specific, and lockfile/frozen-mode based. Examples: PyPI domains for Python/uv projects; npm registry domains for Node projects.
- OS package registries such as APT mirrors are not allowed in the runtime container.
- `ghcr.io` is not required inside the container; the host launcher pulls the image.

### Failure handling

Target-state behavior:
* If Envoy cannot start, the launcher fails before starting the AI harness container.
* If the Unix socket does not appear, the launcher fails.
* If the in-container socat bridge cannot start, the entrypoint fails.
* If a request does not match the allow-list, Envoy denies it.
* If a process bypasses proxy configuration, it has no network path due to `--network none`.

### Broad web research / Web Fetch

Direct URL fetching and broad internet research conflict with a narrow runtime allow-list. The baseline design does not open general internet egress for this use case. Future design work will define a separate retrieval plane.

---

## Authentication

Authentication spans the launcher (credential retrieval) and the entrypoint (credential use and cleanup). This section covers both together.

### Secrets

Two authentication secrets are required:
* **AI harness credential** — either a Claude Code OAuth token (Anthropic backend) or a DeepSeek API key (DeepSeek backend).
* **GitHub Token** — for repository access.

Both are stored in the host Secret Service keyring, retrieved by the launcher, and injected into the container at startup.

### Secret naming in keyring

| Secret | Service | Account | Key |
|---|---|---|---|
| Claude Code OAuth token | `adda-dev` | `claude` | `oauth` (default) |
| GitHub Token | `adda-dev` | `github` | repo-specific (e.g. `acme-token`) |
| DeepSeek API key | `adda-dev` | `deepseek` | `apikey` (default) |

All entries use the `adda-dev` service namespace. `account` identifies the target system; `key` identifies the credential within that system, configured per-repo in `adda-dev.env` via `ADDA_DEV_KEYRING_GITHUB_KEY`, `ADDA_DEV_KEYRING_CLAUDE_KEY`, and `ADDA_DEV_KEYRING_DEEPSEEK_KEY`. Multiple GitHub repos can coexist in one keyring by using distinct key values (e.g. `acme-token`, `otherrepo-token`).

### One-time bootstrap: Claude Code OAuth token

Acquire the token using a throwaway container:

```bash
docker run --rm -it oven/bun:latest \
  sh -c "BUN_INSTALL=/usr/local bun install -g @anthropic-ai/claude-code && claude setup-token"
```

Procedure:
1. The container prints an authorization URL.
2. Open it in the host browser.
3. Authorize.
4. Copy the authorization code back into the container.
5. Claude Code exchanges the code for an OAuth token and displays it.
6. Store the token in the host keyring:

```bash
secret-tool store --label='Claude Code OAuth' \
  service adda-dev account claude key oauth
```

### One-time bootstrap: GitHub Token

Generate a fine-grained Personal Access Token in GitHub and store it directly in the keyring:

```bash
secret-tool store --label='Claude Code GitHub Token ({repo})' \
  service adda-dev account github key {repo}-token
```

Replace `{repo}` with the actual repository name. The `{repo}-token` value must match `ADDA_DEV_KEYRING_GITHUB_KEY` in that repo's `adda-dev.env`.

### Retrieval

The launcher retrieves the required credentials at runtime:

```bash
CLAUDE_CODE_OAUTH_TOKEN=$(secret-tool lookup service adda-dev account claude key oauth)
GITHUB_TOKEN_=$(secret-tool lookup service adda-dev account github key {repo}-token)
```

If either lookup returns empty, the launcher fails fast with a bootstrap-procedure pointer.

### Rotation

Re-run the bootstrap or GitHub token generation procedure and store a replacement value using the same `secret-tool store` attributes. Recommended GitHub Token rotation interval: 90 days or less.

### GitHub Token scoping

Hard requirements:
* Repository scope: exactly one repository, `{owner}/{repo}`.
* No account-level permissions.
* No repository administration permissions.
* No access to secrets, variables, environments, deployments, webhooks, Pages, Codespaces, or repository settings.

Baseline repository permissions:

| Permission | Access | Why |
|---|---|---|
| Metadata | Read | Prerequisite for everything else. |
| Contents | Read & write | Clone, fetch, push, branch creation/deletion. |
| Issues | Read & write | Issue creation, labels, comments, phase tracking. |
| Pull requests | Read & write | PR creation, comments, review/status updates. |
| Workflows | Read & write | Required if SDLC-governed work modifies `.github/workflows/*`. |
| Actions | Read | Read CI status and quality-gate results. |

Grey-area permissions are added only when a named SDLC operation requires them and the reason is documented in the repository.

---

## Filesystem and process hardening

### Container process privileges

The AI harness container is launched with:

```bash
--cap-drop ALL
--security-opt no-new-privileges
```

Expected runtime diagnostics:

```text
CapEff:        0000000000000000
NoNewPrivs:    1
```

No capability is added back for firewall or network configuration. Network enforcement is outside the container.

### Read-only root filesystem

The AI harness container root filesystem is read-only:

```bash
docker run --read-only
```

Writable paths are explicit tmpfs mounts. The design assumes a single effective runtime user inside the container. Writable mounts are owned by that runtime UID/GID and are private by default.

### Runtime user configuration

Defined in the launcher/project configuration:

```bash
ADDA_DEV_USER=adda
ADDA_DEV_UID=1000
ADDA_DEV_GID=1000
ADDA_DEV_HOME=/home/adda
```

The image must run as that user, or the entrypoint should warn that runtime UID/GID do not match the expected configuration.

### Writable tmpfs mounts

| Path | Mode | Exec? | Purpose |
|---|---|---|---|
| `/home/${ADDA_DEV_USER}` | `0700` | yes | AI harness state, gh config, git config, runtime state, shell config. |
| `/workspace` | `0700` | yes | Repository checkout, project writes, test/build output. |
| `/tmp` | `0700` | yes | Temporary files; exec permitted for tools that create and run temp scripts. |
| `/var/tmp` | `0700` | yes | Temporary files for tools that use `/var/tmp`. |
| `/run` | `0700` | no | Runtime files and mounted proxy socket. |

`$HOME` and `/workspace` must permit execution because language tooling may install executable interpreters, virtualenvs, or scripts there. `/run` should be `noexec`; it exists for runtime/socket files.

Tmpfs sizes are configured by launcher variables:

```bash
ADDA_DEV_HOME_TMPFS_SIZE=500m
ADDA_DEV_WORKSPACE_TMPFS_SIZE=200m
```

Sizes are limits, not pre-allocated RAM reservations.

### Proxy socket mount

The Envoy Unix socket is bind-mounted into the container as an immediate child of `/run` (e.g. `/run/proxy.sock`). This avoids relying on nested parent directories under a tmpfs-mounted `/run`.

Socket permissions must allow the container runtime user to connect despite possible UID/GID mismatch between host user, Envoy sidecar process, and container user.

### Expected Docker-managed mounts

Docker provides managed files (`/etc/hosts`, `/etc/hostname`, `/etc/resolv.conf`). These do not by themselves provide network access and should be treated as expected Docker runtime configuration unless they contain unexpected content.

---

## Tier 1

### Entrypoint

Container-side script (`entrypoint.sh`). Validates the runtime contract, starts the proxy bridge, bootstraps the repository, sources `entrypoint.d/` hooks, runs the Tier 3 init hook if present, and hands off to CMD.

#### Behavior

1. Print welcome banner.

2. Validate required environment variables. Optionally display image identity variables (`ADDA_DEV_RUNTIME_IMAGE`, `ADDA_DEV_RUNTIME_IMAGE_COMMIT_SHA`) when present.

3. Verify `/workspace` is empty.

4. Report diagnostic hardening checks:
   * loopback-only network expected;
   * no default route expected;
   * no effective capabilities expected;
   * `NoNewPrivs: 1` expected;
   * root filesystem read-only expected;
   * expected tmpfs mounts present;
   * expected tmpfs mounts writable by current user;
   * `$HOME` and `/workspace` executable;
   * `/run` noexec;
   * no unexpected writable non-tmpfs mounts.

5. Install bootstrap-complete marker EXIT trap. From this point on, any premature exit (failure or signal) touches `/run/.adda_bootstrap_complete` so the parallel interactive shell can open for autopsy.

6. Start `socat` bridge from `127.0.0.1:${ADDA_DEV_PROXY_PORT}` to `${ADDA_DEV_PROXY_SOCKET}`. See *Network*.

7. Export proxy environment variables. See *Network*.

8. Configure GitHub authentication using `gh auth login --with-token`. See *Authentication*.

9. Remove `GITHUB_TOKEN_` from the process environment after GitHub authentication is initialized. Set `GH_REPO=${GITHUB_OWNER}/${GITHUB_REPO}` so subsequent gh calls have a repo default.

10. Configure git identity.

11. Clone `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}.git` into `/workspace`.

12. Resolve working branch:
    * no `ISSUE_ID`: remain on `main`;
    * issue has no linked branch: remain on `main`;
    * issue has one linked branch: check it out;
    * issue has multiple linked branches: fail and ask Project Owner to resolve ambiguity.

13. Source `entrypoint.d/` hooks — run each `.sh` file in `/usr/local/libexec/adda-dev-runtime/bootstrap/entrypoint.d/` in lexicographic order. Hooks are sourced (not subprocess) so they may export variables into the bootstrap environment. The directory is always present; an empty directory is not an error.

14. Run Tier 3 repo init hook: execute `/workspace/.adda-init.sh` as a subprocess if it exists. Non-existence is not an error. See *Tier 3 — init hook*.

15. Write `~/.bashrc` with `PS1` and propagated environment variables (`HTTP_PROXY`, `HTTPS_PROXY`, `http_proxy`, `https_proxy`, `NO_PROXY`, `no_proxy`, `GH_REPO`). Touch bootstrap-complete marker at `/run/.adda_bootstrap_complete`. The marker is also touched by the EXIT trap installed in step 5 so it is created even on bootstrap failure.

16. Print session summary.

17. Exec Docker image's CMD. Tier 1 defaults CMD to `/bin/bash`; Tier 2 and Tier 3 images may override it.

18. If CMD exits, drop to an interactive shell for inspection.

19. On final shell exit, print git status and unpushed commit trail.

#### Branch resolution

Branch lookup uses GitHub's first-class Issue branch linkage, not a naming convention. Implementation may use GitHub GraphQL to query linked branches. The branch naming convention remains documentation; the entrypoint stays convention-agnostic.

### Bootstrap extension points

#### `entrypoint.d/` mechanism

Hooks in `/usr/local/libexec/adda-dev-runtime/bootstrap/entrypoint.d/` are sourced by the entrypoint after core bootstrap completes (GitHub auth, clone, and branch resolution are done). Hooks are sourced — not subprocess — so they share the entrypoint's shell environment and may export variables downstream.

Hooks are named with a numeric prefix for explicit ordering (e.g. `10-name.sh`). Multiple hooks are sourced in lexicographic order.

Available helper functions (sourced from Tier 1):
- `require_env <VAR>` — fail with a clear message if the variable is unset or empty.
- `require_tool <cmd>` — fail with a clear message if the command is not found.
- `section <title>` — print a formatted section header.
- `success <msg>` — print a success line.
- `die <msg>` — print an error and exit non-zero.

The `entrypoint.d/` directory is created by the Tier 1 Dockerfile and is always present. An empty directory is not an error.

### libexec layout

Scripts and executables are installed under `/usr/local/libexec/adda-dev-runtime/` and split into two subdirectories by purpose.

#### `bootstrap/` — startup scripts

Contains scripts that run during container startup: `entrypoint.sh`, the `entrypoint.d/` hook directory, and the interactive-shell helper. These scripts run before the agent starts and are not intended to be invoked by the agent.

#### `bin/` — runtime executables (agent-invokable)

Contains executables the agent may invoke during a session.

#### Artifact routing table

Shell scripts (`.sh.source`) carry no exec bit in the repo; the Dockerfile renames them (strips `.source`) and sets the exec bit. Bun executables are compiled from `.ts` source in a multi-stage build.

`<libexec>` expands to `/usr/local/libexec/adda-dev-runtime`:

```
Source                                                                         Destination
──────────────────────────────────────────────────────────────────────────────────────────────────────
Tier 1 (adda-dev-runtime)
  adda-dev-runtime/content/scripts/bootstrap/entrypoint.sh.source             <libexec>/bootstrap/entrypoint.sh
  adda-dev-runtime/src/runtime/<name>.ts                                       <libexec>/bin/<name>
  adda-dev-runtime/src/bootstrap/<name>.ts                                     <libexec>/bootstrap/<name>
  adda-dev-runtime/content/scripts/runtime/<name>.sh.source                    <libexec>/bin/<name>.sh
  adda-dev-runtime/content/scripts/bootstrap/<name>.sh.source                  <libexec>/bootstrap/<name>.sh

Tier 2 (proto-adda)
  proto-adda/src/runtime/<name>.ts                                              <libexec>/bin/<name>
  proto-adda/src/bootstrap/<name>.ts                                            <libexec>/bootstrap/<name>
  proto-adda/content/scripts/runtime/<name>.sh.source                           <libexec>/bin/<name>.sh
  proto-adda/content/scripts/bootstrap/<name>.sh.source                         <libexec>/bootstrap/<name>.sh
  proto-adda/content/scripts/bootstrap/entrypoint.d/<h>.sh.source               <libexec>/bootstrap/entrypoint.d/<h>.sh
```

### Image build and distribution

#### Shared conventions

These conventions apply to all images in the tier stack.

**Version pinning:** all tool versions are pinned via `ENV` variables in the Dockerfile. A version comment block at the top of each Dockerfile is the visible source of truth; bumps go through an explicit chore Issue.

**Base image pinning:** `FROM` lines are pinned to specific point releases, not rolling tags (e.g. `debian:12.11-slim`, not `debian:bookworm-slim`). Exception: during cross-tier development, a Tier 2 feature branch may deliberately reference the Tier 1 `edge` tag as a floating target for testing against the latest Tier 1 main-branch changes before a release is cut.

**apt packages:** package versions are *not* pinned to specific apt version strings. Debian stable's release policy (security and critical bug-fix updates only within a minor release) is the structural pin. Hadolint DL3008 is suppressed inline with a rationale comment.

**Dockerfile quality:** hadolint runs in CI on every Dockerfile change.

**TypeScript compilation:** Bun executables are compiled in a multi-stage build. A `bun-builder` stage compiles `.ts` source files to extensionless executables; the runtime stage copies only the compiled output and pruned `node_modules`.

**GHCR distribution:** production images are published to GHCR. Each build is tagged with its commit SHA for immutable reference.

**Runtime image identification:** two environment variables carry image identity into every running container:

| Variable | Set by | When empty |
|---|---|---|
| `ADDA_DEV_RUNTIME_IMAGE` | Launcher at run time (`-e` flag) | Not injected (container started without the launcher) |
| `ADDA_DEV_RUNTIME_IMAGE_COMMIT_SHA` | CI at build time (`--build-arg`) | Local builds |

Both are displayed during bootstrap and remain available for the session lifetime. Neither is required; absence is not an error. `ADDA_DEV_RUNTIME_IMAGE` is not baked into the image because the same layer can be referenced under multiple tags; `ADDA_DEV_RUNTIME_IMAGE_COMMIT_SHA` is baked because only CI holds the commit SHA at build time.

#### Tier 1 image

Built from `adda-dev-runtime/Dockerfile`. Published as `ghcr.io/{owner}/adda-dev-runtime`.

| Tag | Updated when | Purpose |
|---|---|---|
| `edge` | Push to `main` | Most recent main-branch build, SHA-stamped |
| `latest` | Release tag push | Most recent versioned release |
| `v{X.Y.Z}` | Release tag push | Immutable versioned release |
| `{sha}` | Every CI build | Immutable commit-linked reference; primary intermediate tag |
| `ci` | Every CI build | Latest CI build (mutable; overwritten each run) |

---

## Tier 2

### Infrastructure contract

**Image:** builds `FROM` a Tier 1 image. The `BASE_TAG` build argument pins the exact Tier 1 image used. The launcher configuration for a Tier 2 image must preserve Tier 1's security model — no capability additions, no network bypass, no privilege escalation.

**Bootstrap hook:** delivers `entrypoint.d/` hooks to `/usr/local/libexec/adda-dev-runtime/bootstrap/entrypoint.d/`. Hooks are sourced by the Tier 1 entrypoint after core bootstrap completes. A Tier 2 image with no hooks is valid.

**CMD:** overrides Tier 1's default CMD (`/bin/bash`) to the AI harness executable, making the harness the primary process.

### `entrypoint.d` hook requirements

A Tier 2 `entrypoint.d/` hook should:
- Use Tier 1 helper functions (`require_env`, `require_tool`, `section`, `success`, `die`) for consistent output and failure handling.
- Validate AI-harness-specific environment variables using `require_env`.
- Validate that the AI harness binary is present using `require_tool`.
- Initialise the AI harness configuration in `$HOME` so that the harness is ready when CMD runs.

### Runtime executables and libexec additions

A Tier 2 implementation may add executables to `/usr/local/libexec/adda-dev-runtime/bin/` and scripts to `/usr/local/libexec/adda-dev-runtime/bootstrap/`, following the same libexec layout defined in Tier 1.

### Image build

Built `FROM` a Tier 1 image. Published under its own name (e.g. `ghcr.io/{owner}/proto-adda-dev-runtime`). Each Tier 2 implementation publishes independently using the same tag conventions as Tier 1.

See `docs/proto-adda.md` for proto-adda image specifics.

---

## Tier 3

### Repository layout

A Tier 3 project is a standard GitHub repository. The technology stack is unconstrained — any language, framework, or tooling. Projects benefit from tools pre-installed in Tier 1 or Tier 2 but are not required to use them.

A Tier 3 project may carry any combination of the following ADDA elements. None are mandatory:

```text
project-repo/
├── <agent-context-file>         # Project-specific agent context (file name set by AI harness)
├── .adda-init.sh                # Project initialization hook (runs at bootstrap and branch switch)
├── Dockerfile                   # FROM <tier2-image>; extends the tier stack for this project
├── .quality-gates.toml          # SDLC: quality gate commands (Coder-invokable)
├── CHANGELOG.md                 # SDLC: running changelog with UPCOMING section
├── docs/
│   ├── architecture.md          # SDLC: project architecture reference (AA/PM)
│   ├── conventions.md           # SDLC: coding conventions reference (AA/Coder)
│   └── {issue-id}-{slug}/       # SDLC: per-feature artifacts
│       ├── spec.md
│       ├── tech-design.md
│       └── impl-plan.md
└── (project source tree)
```

### Init hook (`.adda-init.sh`)

`/workspace/.adda-init.sh`, if present in the repository root, is a repo-level lifecycle hook. Executed (not sourced) by the entrypoint. Guaranteed to run at bootstrap if present; also invoked when the session switches to a different issue and a branch checkout is performed.

#### Discovery

The runtime discovers exactly `/workspace/.adda-init.sh`. No other hook file paths are recognized.

#### Environment

The hook inherits environment variables from the caller — GitHub auth, proxy settings, `BUN_VERSION`, and any variables exported by `entrypoint.d` hooks. Shell functions and sourced helpers from the caller are **not** available.

#### Permitted use

- Install or update project dependencies (`bun install`, `uv sync`, etc.).
- Write files in `/workspace`.
- Exit non-zero to fail the calling operation.

#### Prohibited — modifying the runtime shell environment

`export` statements, PATH modifications, and shell option changes are structurally ineffective across a subprocess boundary. Examples: `export PATH=...`, `export MY_VAR=...`. Such statements execute inside the hook's subprocess and have no effect on the caller's environment.

#### Standalone safety

The hook must:
- Declare its own `set -euo pipefail` — it does not inherit the caller's shell options.
- Use absolute paths — the working directory is not guaranteed.
- Not rely on shell helper functions from the caller.

#### Tool invocation

Install project tools as dependencies and invoke them via their ecosystem runner — for example, `bun run <tool>` for Node/Bun projects, `uv run <tool>` for Python/uv projects. Do not rely on the session PATH for tool invocation.

#### Failure semantics

A non-zero exit from the hook fails the calling operation. An absent hook is not an error.

### Optional Dockerfile

A Tier 3 Dockerfile builds `FROM` the Tier 2 image in use. When present, it gives the project the full capability set available to any tier in the stack:

- **OS-level tooling** — add language runtimes and tools not present in Tier 1 or Tier 2.
- **`entrypoint.d/` hooks** — drop hooks into `/usr/local/libexec/adda-dev-runtime/bootstrap/entrypoint.d/`.
- **CMD override** — customize the command that runs after bootstrap.
- **libexec extensions** — add executables to `bin/` or scripts to `bootstrap/`.

For TypeScript/Bun projects, no Dockerfile is needed; Bun is already in Tier 1.

### Launcher target

When the project carries no Dockerfile, the launcher configuration references the Tier 2 image as the runtime target. When a project Dockerfile is present and built, the launcher configuration references the project image instead — the Tier 2 image becomes an intermediate build stage.
