# ADDA Dev Runtime - Design Document

This document specifies the target design of an isolated, ephemeral, hardened container environment for AI-assisted software development. It covers the tier architecture, design principles, host system, and the per-tier design of the infrastructure, SDLC implementation, and project layers.

Companion to [adda-sdlc.md](https://github.com/nightjarrr/molim/blob/main/docs/adda-sdlc.md) — the vendor-agnostic conceptual design of the ADDA SDLC that this runtime implements.

**Audience: human Project Owner only.** Read at setup time and when modifying the environment. Not part of any agent's runtime context.

Throughout, `{owner}` and `{repo}` refer to the GitHub namespace and repository name of the project.

---

## Design principles

### Ephemeral runtime, stateless agent, persistent GitHub

A dev runtime exists for one feature workflow and is destroyed on exit. The AI agent carries no state across container exits — it rebuilds context at session start by reading GitHub state and repository artifacts. Anything not pushed before exit is lost. This is an intentional and accepted trade-off for isolation and reproducibility.

GitHub is the persistence layer for all project work. Project state flows to GitHub through:

- commits pushed to feature branches;
- Issues — including hierarchies, cross-links, and comments — tracking requirements, design decisions, and outcomes;
- Pull Requests and their review trails;
- GitHub API state (labels, milestones, phase tracking).

Nothing outside GitHub persists: no host source bind mount, no persistent AI harness config volume, no SSH agent forwarding, and no shared host clone are used.

### Defense in depth

Three concentric boundaries protect the host and project from code running inside the development environment:

1. **Container isolation** — the AI harness container has no host filesystem, process, device, display, Docker socket, or network namespace access beyond what the launcher explicitly grants.
2. **Proxy-based network perimeter** — the AI harness container runs with `--network none`. All intended outbound traffic goes through a launcher-managed Envoy sidecar proxy over a mounted Unix domain socket. Envoy enforces a default-deny domain allow-list.
3. **AI harness permission configuration** — enforces least privilege when granting permissions to AI actors: agents, skills, and tools.

Two further protections bound the impact of credential exposure:

* **Host-side keyring** — authentication tokens never reside in plaintext on host disk; the keyring is encrypted at rest and unlocked only by an active login session.
* **Token scoping** — the GitHub Token is recommended to be scoped to a single repository with no administration permissions, bounding GitHub blast radius.

### Host launcher and Envoy are trusted perimeter components

The AI harness container is treated as untrusted. Nothing inside it is assumed to be non-exploitable. The host launcher and the per-session Envoy sidecar are therefore part of the trusted computing base for network and runtime isolation. A user who deliberately bypasses the launcher or weakens the Envoy policy is outside the protection model.

### No plaintext secrets on host disk

Authentication tokens live in the host Secret Service keyring. The launcher retrieves tokens on demand. There is no project `.env` containing secrets, no credentials file, and no token in shell history.

---

## Threat model

### Primary threat: host compromise from code inside the development environment

The environment must prevent any code, tool, dependency, or AI agent running inside the AI harness container from affecting the host system.

Non-negotiable constraints:

* No AI harness install on the host.
* No host home directory mount.
* No host project source bind mount.
* No persistent AI harness config volume.
* No Docker socket inside the container.
* No shared host namespaces: no `--privileged`, no `--network=host`, no `--pid=host`, no `--ipc=host`.
* No host display forwarding: no `DISPLAY`, no X11 socket, no Wayland socket.
* No SSH agent forwarding.
* No general container network egress.
* Non-root user inside the AI harness container.
* `--cap-drop ALL` for the AI harness container.
* No capability add-back for the AI harness container.
* `--security-opt no-new-privileges` to block setuid/file-capability privilege gain.
* Read-only root filesystem with explicit tmpfs mounts for writable runtime paths.

Normal copy/paste between the AI harness's TUI and the host is mediated by the terminal emulator. In-container processes do not receive programmatic access to the host clipboard.

### Limits of container isolation

Container isolation reduces likelihood and blast radius; it does not reduce risk to zero. The host kernel must be patched. Image provenance, base-image discipline, pinned digests, CI provenance, and minimal runtime privileges are part of the mitigation. A determined attacker exploiting an unpatched container escape CVE is outside of this design's guarantee.

### Prompt injection

Adversarial content may reach the AI agent's context through web pages, dependency READMEs, Issue bodies, PR comments, fetched files, or repository content.

Recognized mitigations:

* Ephemeral runtime limits persistence and blast radius.
* Narrow GitHub Token scope prevents cross-repository or account-level damage.
* AI harness permission configuration enforces least privilege.
* Network egress allow-list limits where compromised code can communicate.
* PR review remains the final human gate for code and workflow changes.

Residual risk: hostile content may influence changes on the current branch until caught at review.

### Malicious dependencies

A dependency may execute hostile code during install, test, build, or runtime.

The design distinguishes two dependency classes:

- **Container/toolchain dependencies** — OS packages, shell tools, language managers, Bun, the AI harness, GitHub CLI, `socat`, and other infrastructure needed before the repository is cloned. These are baked into the image at build time and are not installed with root privileges at runtime.
- **Project code dependencies** — dependencies declared by the repository after it is cloned, such as Python packages in `pyproject.toml` / `uv.lock`, Node packages in `package.json` / lockfiles, or analogous ecosystem dependencies. These may need package-registry access at runtime because the repository is not available during generic base-image build.

Target-state mitigations:

- Project dependencies are lockfile-pinned and installed with frozen/locked resolution.
- Package-registry access is allowed only to explicit ecosystem registry domains required by the project bootstrap.
- OS-level/package-manager installation such as `apt install` is not performed at runtime.
- Runtime installs run as the unprivileged container user and write only to ephemeral tmpfs-backed paths.
- Dependabot and PR review govern dependency changes.

Residual risk: a malicious version already present in a reviewed lockfile can still execute inside the isolated container.

### Network exfiltration

A compromised tool or manipulated AI agent may try to send repository contents, tokens, or other data to an attacker-controlled endpoint.

Primary mitigation: the AI harness container has no network interface beyond loopback. Proxy-aware traffic reaches the network only through the Envoy sidecar. Envoy enforces a default-deny domain allow-list.

A process that ignores `HTTP_PROXY` / `HTTPS_PROXY` or opens raw sockets directly should fail because the container runs with `--network none`.

### Token theft

An attacker inside the AI harness container may read tokens available to that process.

Recognized. The container must hold credentials or credential material to function. Mitigations:

* GitHub Token is single-repository and has no administration permissions.
* AI harness OAuth token is revocable.
* The GitHub token is used for `gh auth login` and then removed from the process environment before handing off to the AI harness, where practical.
* Exfiltration routes are constrained by Envoy's allow-list.
* Tokens are never stored in plaintext on host disk.

Accepted residual risk: an attacker in a live session can use available credentials within their granted scope until the session is terminated or tokens are revoked. See *Deferred questions* for a future enhancement: credential injection via proxy, which would remove raw tokens from the container entirely.

### Quota and resource abuse

A runaway AI agent session or hostile instruction may consume API quota, GitHub API rate limits, CPU, memory, or disk.

Mitigations:

* Ephemeral container teardown stops further consumption.
* `tmpfs` sizes bound writable in-memory filesystem growth.
* GitHub API rate limits naturally apply to the token.

---

## Host system and launcher

### Host prerequisites

Linux only, tested on Ubuntu 24.04. Several decisions in this document — POSIX shell launcher, Ghostty as terminal emulator, `tmux` for session survivability, and direct `docker run` orchestration — assume this target. Use on macOS or Windows is not supported; adaptation to those hosts is left to the reader.

Prerequisites:

* Docker Engine or compatible OCI runtime. Desktop is not required.
* Bash.
* `openssl` command-line utility, used by the launcher for random run/session identifiers.
* Ghostty, or another modern terminal emulator.
* `tmux`, used for survivable terminal sessions.
* `libsecret-tools`, providing `secret-tool` for keyring access.
* `seahorse`, optional but recommended for GUI keyring inspection.
* An active GNOME, KDE, or compatible Secret Service login session, so the keyring is unlocked.

Notably **not** required on the host:

* `git`
* `gh`
* The AI harness CLI
* Python, Node, uv, or any project-specific runtime tooling

Those tools live inside containers.

### Launcher script (`adda-dev.sh`)

Host-side script. Its job is to create one ephemeral AI harness dev runtime.

Invocation:

```bash
adda-dev.sh
adda-dev.sh <issue-id>
adda-dev.sh -- <cmd> [args...]
adda-dev.sh <issue-id> -- <cmd> [args...]
```

#### Per-project configuration

The launcher reads `adda-dev.env` from the same directory as the launcher script.

Required target variables:

```bash
#Github repo
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

#### Behavior

1. Validate arguments.
2. Verify host prerequisites: `docker`, `secret-tool`, `tmux`, `openssl`.
3. Source `adda-dev.env` and validate required variables.
4. Seed `~/.tmux.conf` from `scripts/adda-dev.tmux.conf` only if missing; source it best-effort.
5. If not already inside tmux, generate a session name, export it, and re-enter the launcher inside a named tmux session.
6. Retrieve auth tokens from Secret Service keyring.
7. Detect host timezone.
8. Create a private per-run runtime directory under `${XDG_RUNTIME_DIR:-/tmp}`.
9. Render Envoy config from `envoy.yaml.template`, co-located with the launcher script, into the runtime directory.
10. Start Envoy sidecar container with hardened flags.
11. Wait for the Envoy Unix socket.
12. Create `adda-dev shell` and `adda-dev envoy logs` windows in the primary tmux session. The `adda-dev shell` window invokes a container-side script that waits for bootstrap to finish before opening the interactive bash prompt.
13. Assemble and run the AI harness container with:

    * `--rm -it`
    * `--network none`
    * `--cap-drop ALL`
    * `--security-opt no-new-privileges`
    * `--read-only`
    * explicit tmpfs mounts
    * Envoy socket bind mount
    * required environment variables
14. On exit, stop Envoy and remove the runtime directory.

#### Envoy sidecar hardening

The Envoy sidecar is outside the AI harness container trust boundary but should still be minimized:

* exact image version and digest in target state;
* `--rm -d`;
* `--cap-drop ALL`;
* `--security-opt no-new-privileges`;
* read-only root where compatible;
* tmpfs for `/tmp`;
* admin interface not published to host; accessible via `docker exec` only.

### Terminal emulator and tmux

#### Ghostty

Ghostty is the preferred terminal emulator. Increase host terminal scrollback if desired:

```text
scrollback-limit = 100000000
```

#### tmux

The launcher uses tmux for survivability. It may seed user tmux config from `scripts/adda-dev.tmux.conf` only when `~/.tmux.conf` is absent. Existing user tmux config is never overwritten.

Recommended seed behavior:

* large scrollback;
* mouse mode enabled;
* slower mouse-wheel scrolling in copy mode;
* short escape-time for responsive TUIs;
* focus events enabled;
* true-color terminal features;
* clipboard/passthrough/title mutation disabled for safety;
* no `remain-on-exit failed` default, because dead-pane UX is poor.

With tmux mouse mode enabled, normal terminal selection may require Shift-drag depending on terminal emulator.

Common tmux actions:

```text
Ctrl-b d     detach from session
Ctrl-b [     enter copy mode
Ctrl-b x     kill pane
```

---

## Tier architecture

The ADDA development runtime is organised into three tiers. Each tier has a distinct concern and a distinct form.

### Tier 1 — infrastructure

**What it is:** the hardened, isolated, ephemeral container that ADDA-based development runs inside. Provides base OS packages, `git`, `gh`, `curl`, `jq`, `rg`, `fdfind`, Bun, a runtime user, and the entrypoint with its `entrypoint.d/` hook mechanism.

**Why it exists as an image:** Tier 1 is pure infrastructure. Packaging it as a Docker image gives every higher tier and every project a reproducible, version-pinned base with no host-side toolchain requirements.

**What it does not include:** any AI harness, any AI harness configuration, or any project-specific tooling. Tier 1 is AI-harness-agnostic by design.

**Bun as the Tier 1 scripting runtime:** Bun is included in Tier 1 as the shared scripting runtime for ADDA infrastructure scripts — the criterion for inclusion was that placing a runtime in Tier 1 makes it available to all higher tiers without additional setup. This is a deliberate architectural choice, not a project-specific convenience. It has the side effect that TypeScript/Bun Tier 3 projects require no additional tooling layer; all other language runtimes must be added at Tier 2 or Tier 3.

**Image:** `ghcr.io/{owner}/adda-dev-runtime`

### Tier 2 — ADDA SDLC implementation

**What it is:** a runnable image that packages a specific AI harness together with a complete implementation of the ADDA SDLC for that harness. Builds `FROM` Tier 1 and adds the AI harness binary, the SDLC methodology (agent config, skills, settings, agent definitions), and a bootstrap hook that initialises the agent's working environment at container start.

**Why it exists as an image:** the SDLC methodology and its AI harness must be distributed together as a versioned, reproducible unit. An image is the correct packaging for a self-contained, runnable system.

**Multiple Tier 2 implementations:** Tier 2 is not a single image — it is a role. Multiple Tier 2 implementations can coexist as siblings, each pairing a different AI harness or a different SDLC implementation with the same Tier 1 base:
- **proto-adda** — current implementation; Claude Code with a simplified SDLC. "Proto" reflects that it is a prototype: it covers the core workflow but does not implement all ADDA roles (Associate Architect is collapsed into PM). See `docs/proto-adda.md` for implementation specifics.
- **DAWE** — planned full ADDA SDLC implementation (including a distinct Associate Architect subagent). See [dawe-proposal.md](https://github.com/nightjarrr/molim/blob/main/docs/claude-sdlc/dawe-proposal.md).

The Tier 2 agent configuration (deployed to the AI harness's configuration directory at container start) contains the SDLC workflow, roles, working principles, and release process. It contains no project-specific content.

### Tier 3 — the project

**What it is:** the GitHub repository of the actual software being developed. Tier 3 is not an image and not infrastructure — it is the project that uses a Tier 2 runtime to develop itself.

**Form:** a GitHub repository, cloned into `/workspace` at container start. The project supplies the agent with project-specific orientation (architecture, conventions, toolchain). The SDLC methodology is inherited from the Tier 2 image.

**Optional infrastructure elements** — a Tier 3 project may carry infrastructure only when strictly necessary:

- **`.adda-init.sh`** — a repo-level init hook run as a subprocess after bootstrap. Used to install project dependencies (`bun install`, `uv sync`, etc.). Appropriate when project dependencies must be installed at runtime rather than baked into an image. Cannot modify the calling shell's environment (subprocess boundary).

- **`FROM Tier2` Dockerfile** — a project-specific image that extends a Tier 2 image with additional OS-level tooling. Appropriate when the project's language runtime is not provided by Tier 1 (e.g. Python, Go, Java). For TypeScript/Bun projects, Bun is already in Tier 1 and no Dockerfile is needed.

The choice between init hook and Dockerfile turns on the project's toolchain: if the language runtime is in Tier 1, an init hook that installs packages suffices; if the runtime itself must be added, a Dockerfile is the clean solution (bootstrapping a full language runtime via `curl` in an init hook is fragile).

### Tier summary

| | Tier 1 | Tier 2 | Tier 3 |
|---|---|---|---|
| **Concern** | Infrastructure | ADDA SDLC implementation | The project being developed |
| **Form** | Docker image | Docker image (`FROM` Tier 1) | GitHub repository |
| **Examples** | `adda-dev-runtime` | `proto-adda`, `DAWE` (planned) | any project using ADDA |
| **Agent config** | — | Bundled SDLC implementation, project-agnostic | Project-specific harness configuration and context |
| **Multiplicity** | One | One per AI harness / SDLC implementation | One per project |

---

## Tier 1 — infrastructure

### Container and session model

One AI harness development session corresponds to one isolated AI harness container and one dedicated network perimeter sidecar.

| Concept                   | Mapping                      |
| ------------------------- | ---------------------------- |
| One GitHub Issue          | One feature workflow         |
| One feature workflow      | One AI harness session       |
| One AI harness session    | One AI harness process       |
| One AI harness process    | One AI harness container     |
| One AI harness container  | One Envoy sidecar proxy      |
| One AI harness container  | One host `tmux` session      |

Subagents run inside the parent AI harness process. They do not get separate containers.

#### Lifecycle

A session is created when work begins:

```bash
adda-dev.sh
adda-dev.sh <issue-id>
```

It runs while work is active and is destroyed when the session exits. Resuming work creates a new runtime and reloads state from GitHub.

Per-session runtime lifecycle:

1. Launcher validates host prerequisites and project config.
2. Launcher retrieves credentials from the host keyring.
3. Launcher starts the Envoy sidecar container with a per-run runtime directory.
4. Launcher waits for Envoy's Unix socket.
5. Launcher starts the AI harness container with `--network none` and the Envoy socket mounted into it.
6. Entrypoint starts an in-container `socat` bridge from loopback TCP to the mounted Unix socket.
7. Entrypoint configures GitHub auth, clone, branch selection, and project bootstrap.
8. Entrypoint sources `entrypoint.d/` hooks, then runs the Tier 3 init hook if present.
9. Entrypoint execs CMD (Tier 1 default: `/bin/bash`; Tier 2 overrides to the AI harness executable).
10. On exit, launcher stops Envoy and removes the runtime directory.

#### Concurrency

Multiple features may run concurrently. Each invocation gets its own AI harness container, Envoy sidecar, runtime directory, Unix socket, and tmux session. Containers share no state with each other except through GitHub.

#### TUI requirements

The AI harness is a TUI application. The container provides a real PTY (`docker run -it`), `TERM=xterm-256color` or compatible behavior, and a UTF-8 locale.

Micro is installed as the default TUI editor (`EDITOR=micro`, `VISUAL=micro`). It is available for interactive file editing and is the fallback editor for CLI tools that open `$EDITOR` (e.g. `git commit`, `gh pr create`).

delta is installed as the git diff pager. All `git diff`, `git show`, `git log -p`, and `git add -p` output is automatically routed through delta for syntax highlighting, line numbers, and hunk navigation (n/N).

#### Survivability

The launcher creates a named host `tmux` session and re-enters itself inside that session. This keeps the launcher, Envoy sidecar lifecycle, and `docker run` under tmux control. If the terminal emulator crashes or closes, the tmux server keeps the session alive. Reattach using the printed tmux session name.

The launcher also opens a `adda-dev shell` window (interactive bash in the container) and a `adda-dev envoy logs` window (`docker logs -f` on the Envoy sidecar) in the same session.

---

### Authentication

Authentication secrets:

* AI harness credential — either a Claude Code OAuth token (Anthropic backend) or a DeepSeek API key (DeepSeek backend), depending on the configured backend.
* GitHub Token for repository access.

These are stored in the host Secret Service keyring, retrieved by the launcher, and injected into the container at startup.

#### Secret naming in keyring

| Secret                  | Service      | Account    | Key                               |
| ----------------------- | ------------ | ---------- | --------------------------------- |
| Claude Code OAuth token | `adda-dev` | `claude`   | `oauth` (default)                 |
| GitHub Token            | `adda-dev` | `github`   | repo-specific (e.g. `acme-token`) |
| DeepSeek API key        | `adda-dev` | `deepseek` | `apikey` (default)                |

All entries use the `adda-dev` service namespace. `account` identifies the target system; `key` identifies the credential within that system and is configured per-repo in `adda-dev.env` via `ADDA_DEV_KEYRING_GITHUB_KEY`, `ADDA_DEV_KEYRING_CLAUDE_KEY`, and `ADDA_DEV_KEYRING_DEEPSEEK_KEY`. Multiple GitHub repos can coexist in one keyring by using distinct `key` values (e.g., `acme-token`, `otherrepo-token`).

#### One-time bootstrap: Claude Code OAuth token

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

#### One-time bootstrap: GitHub Token

Generate a fine-grained Personal Access Token in GitHub and store it directly in the keyring:

```bash
secret-tool store --label='Claude Code GitHub Token ({repo})' \
  service adda-dev account github key {repo}-token
```

Replace `{repo}` with the actual repository name (e.g., `acme`). The `{repo}-token` value must match `ADDA_DEV_KEYRING_GITHUB_KEY` in that repo's `adda-dev.env`. Using distinct values per repo enables simultaneous sessions against different repositories from the same keyring.

Github token scoping and permissions are explained further in **GitHub Token scoping** section.

#### Retrieval

The launcher retrieves the required credentials at runtime:

```bash
CLAUDE_CODE_OAUTH_TOKEN=$(secret-tool lookup service adda-dev account claude key oauth)
GITHUB_TOKEN_=$(secret-tool lookup service adda-dev account github key {repo}-token)
```

If either lookup returns empty, the launcher fails fast with a bootstrap-procedure pointer.

#### Rotation

Re-run the bootstrap or GitHub token generation procedure and store a replacement value using the same `secret-tool store` attributes. Recommended GitHub Token rotation interval: 90 days or less.

#### GitHub Token scoping

Hard requirements:

* Repository scope: exactly one repository, `{owner}/{repo}`.
* No account-level permissions.
* No repository administration permissions.
* No access to secrets, variables, environments, deployments, webhooks, Pages, Codespaces, or repository settings.

Baseline repository permissions:

| Permission    | Access       | Why                                                            |
| ------------- | ------------ | -------------------------------------------------------------- |
| Metadata      | Read         | Prerequisite for everything else.
| Contents      | Read & write | Clone, fetch, push, branch creation/deletion.                  |
| Issues        | Read & write | Issue creation, labels, comments, phase tracking.              |
| Pull requests | Read & write | PR creation, comments, review/status updates.                  |
| Workflows     | Read & write | Required if SDLC-governed work modifies `.github/workflows/*`. |
| Actions       | Read         | Read CI status and quality-gate results.                       |

Grey-area permissions are added only when a named SDLC operation requires them and the reason is documented in the repository.

---

### Network policy

#### Target architecture

The AI harness container has no general network interface:

```text
AI harness (inside container, --network none)
  -> loopback HTTP proxy endpoint
  -> in-container socat bridge
  -> mounted Unix domain socket
  -> Envoy sidecar proxy
  -> allowed internet destinations
```

The network perimeter is outside the AI harness container. Nothing inside the untrusted container is able to enforce its own network rules.

#### Container networking

The AI harness container is launched with:

```bash
--network none
```

Expected properties:

* Only loopback is available inside the container.
* There is no default route.
* Direct DNS resolution to internet resolvers is unavailable.
* Direct TCP connections to internet IPs fail.
* Tools that ignore proxy settings fail to reach the network.

#### Proxy bridge

Most applications understand HTTP proxies as `host:port`, not Unix sockets. The entrypoint therefore starts a `socat` bridge inside the container:

```text
127.0.0.1:<ADDA_DEV_PROXY_PORT>
  -> <ADDA_DEV_PROXY_SOCKET>
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

For HTTPS destinations, clients send HTTP `CONNECT` to Envoy. Envoy sees the target authority, such as `api.github.com:443`, but does not decrypt TLS in the baseline design.

#### Envoy sidecar

Envoy runs as a separate sidecar container managed by the launcher. It is not inside the AI harness container.

Envoy responsibilities:

* Listen on a Unix domain socket.
* Accept explicit HTTP proxy traffic.
* Support plain HTTP forwarding.
* Support HTTPS `CONNECT` tunneling.
* Enforce domain allow-list / default-deny policy using RBAC.
* Resolve allowed upstream domains.
* Emit access logs for audit/debugging.
* Expose an admin interface on container loopback for diagnostics; it is not published to the host and is accessible via `docker exec`.

Envoy is per-session. One AI harness container gets one Envoy sidecar.

#### Envoy admin interface

The Envoy admin interface is bound to container loopback (`127.0.0.1:9901`) and is not published to any host port. Parallel Envoy sidecars can coexist without port conflicts.

To access the admin interface for diagnostics, use `docker exec` into the named Envoy container. The Envoy image runs as a non-root user and does not include HTTP client tools; use bash's built-in TCP support instead (HTTP/1.1 required — Envoy rejects HTTP/1.0):

```bash
docker exec adda-dev-envoy-<RUN_ID> bash -c \
  'exec 3<>/dev/tcp/127.0.0.1/9901
   printf "GET /ready HTTP/1.1\r\nHost: localhost\r\n\r\n" >&3
   cat <&3'
```

Replace `/ready` with `/stats`, `/listeners`, `/clusters`, or `/config_dump` for other diagnostic endpoints.

It is for diagnostics only: readiness, stats, listeners, clusters, config dump, and troubleshooting. It is not a policy editing UI and must not be exposed to untrusted networks.

**Future:** when allow-list enforcement and WebFetch/WebSearch handling are implemented, revisit whether to publish the admin interface to host loopback for operational use.

#### Allow-list

Target-state allow-list is default-deny. Requests are allowed only if the requested authority matches an explicit policy.

Baseline target destinations:

| Destination | Why |
| --- | --- |
| `api.anthropic.com` | Claude Code API calls. |
| `claude.ai` | Claude Code auth/runtime flows where required. |
| `statsig.anthropic.com` | Claude Code telemetry / feature gates, if required by current Claude Code behavior. |
| `sentry.io` | Claude Code error reporting, if required by current Claude Code behavior. |
| `github.com` | Git over HTTPS, web endpoint dependencies. |
| `api.github.com` | GitHub CLI issue, PR, label, branch linkage, and account API calls. |
| `raw.githubusercontent.com` | Raw repository content where required. |
| `objects.githubusercontent.com` | GitHub release assets and Git LFS objects where required. |
| narrowly scoped `githubusercontent.com` hosts | GitHub-hosted raw/assets content where required. |

Runtime package-registry access:

- Container/toolchain dependencies are baked into the image and do not require runtime package-manager access.
- Project code dependencies may require runtime registry access because the repository is cloned by the entrypoint after the container starts.
- Registry access must be explicit, ecosystem-specific, and lockfile/frozen-mode based. Examples: PyPI domains (`pypi.org`, `files.pythonhosted.org`) and the uv installer domain (`releases.astral.sh`) for Python/uv projects; npm registry domains for Node projects; or equivalent domains for other ecosystems.
- OS package registries such as Ubuntu/Debian APT mirrors are not allowed in the runtime container.

Target-state non-goals for runtime allow-list:

- `ghcr.io` is not required inside the container. The host launcher pulls the image.
- Arbitrary direct web fetch is not part of the baseline network policy.

#### Allow-list implementation

Default-deny is achieved via Envoy RBAC `action: ALLOW` — no explicit wildcard deny rule is needed; a request that matches no policy entry is denied automatically. Policy match basis is `:authority`. For HTTPS `CONNECT`, authority is `host:port` (e.g. `api.github.com:443`); for plain HTTP, authority may be `host` or `host:port` — allow-list entries must account for both forms. The dynamic forward proxy cluster is retained; the RBAC filter restricts it before DNS resolution and upstream connection.

#### DNS

The AI harness container does not resolve internet destinations for proxied traffic. It only connects to loopback. Envoy receives the requested authority from the explicit proxy request and resolves allowed destinations from the sidecar container.

Policy should be applied before DNS resolution and before upstream connection.

#### Failure handling

Target-state behavior:

* If Envoy cannot start, the launcher fails before starting the AI harness container.
* If the Unix socket does not appear, the launcher fails.
* If the in-container `socat` bridge cannot start, the entrypoint fails.
* If a request does not match the allow-list, Envoy denies it.
* If a process bypasses proxy configuration, it has no network path due to `--network none`.

#### Broad web research / Web Fetch

Direct URL fetching and broad internet research are recognized as a separate capability class. They conflict with a narrow runtime allow-list if executed inside the container.

Target-state baseline: do not open general internet egress from the container for this use case.

Future design work: define a separate retrieval plane or tool boundary for user-approved web research/fetch, isolated from the writable project container and credentials.

---

### Filesystem and process hardening

#### Container process privileges

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

#### Read-only root filesystem

The AI harness container root filesystem is read-only:

```bash
docker run --read-only
```

Writable paths are explicit tmpfs mounts. The design assumes a single effective runtime user inside the container. Writable mounts are owned by that runtime UID/GID and are private by default.

#### Runtime user configuration

The launcher/project configuration defines:

```bash
ADDA_DEV_USER=adda
ADDA_DEV_UID=1000
ADDA_DEV_GID=1000
ADDA_DEV_HOME=/home/adda
```

The image must run as that user, or the entrypoint should warn that runtime UID/GID do not match the expected configuration.

#### Writable tmpfs mounts

Target writable mounts:

| Path                 | Mode   | Exec?             | Purpose                                                                     |
| -------------------- | ------ | ----------------- | --------------------------------------------------------------------------- |
| `/home/${ADDA_DEV_USER}` | `0700` | yes               | AI harness state, gh config, git config, runtime state, shell config. |
| `/workspace`         | `0700` | yes               | Repository checkout, project writes, test/build output.                     |
| `/tmp`               | `0700` | yes               | Temporary files; exec permitted for tools that create and run temp scripts.  |
| `/var/tmp`           | `0700` | yes               | Temporary files for tools that use `/var/tmp`.                              |
| `/run`               | `0700` | no                | Runtime files and mounted proxy socket.                                     |

`$HOME` and `/workspace` must permit execution because language tooling may install executable interpreters, virtualenvs, or scripts there.

`/run` should be `noexec`; it exists for runtime/socket files.

Tmpfs sizes are configured by project/launcher variables, for example:

```bash
ADDA_DEV_HOME_TMPFS_SIZE=500m
ADDA_DEV_WORKSPACE_TMPFS_SIZE=200m
```

Sizes are limits, not pre-allocated RAM reservations. Linux tmpfs consumes host memory/swap according to actual usage.

#### Proxy socket mount

The Envoy Unix socket is bind-mounted into the container as an immediate child of `/run`, for example:

```text
/run/proxy.sock
```

This avoids relying on nested parent directories under a tmpfs-mounted `/run`.

The socket file itself is created by Envoy in the launcher runtime directory. Socket permissions must allow the container runtime user to connect despite possible UID/GID mismatch between host user, Envoy sidecar process, and container user. The private per-run host runtime directory plus narrow socket bind mount form the main access boundary.

#### Expected Docker-managed mounts

Docker may still provide managed files such as:

* `/etc/hosts`
* `/etc/hostname`
* `/etc/resolv.conf`

These do not by themselves provide network access. They should be treated as expected Docker runtime configuration files unless they contain unexpected content.

---

### Entrypoint (`entrypoint.sh`)

Container-side script. It validates the runtime contract, starts the local proxy bridge, bootstraps the repository, sources `entrypoint.d/` hooks, runs the Tier 3 init hook if present, and hands off to CMD.

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

6. Start `socat` bridge from `127.0.0.1:${ADDA_DEV_PROXY_PORT}` to `${ADDA_DEV_PROXY_SOCKET}`.

7. Export proxy environment variables.

8. Configure GitHub authentication using `gh auth login --with-token`.

9. Remove `GITHUB_TOKEN_` from the process environment after GitHub authentication is initialized. Set `GH_REPO=${GITHUB_OWNER}/${GITHUB_REPO}` so subsequent gh calls have a repo default.

10. Configure git identity.

11. Clone `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}.git` into `/workspace`.

12. Resolve working branch:

    * no `ISSUE_ID`: remain on `main`;
    * issue has no linked branch: remain on `main`;
    * issue has one linked branch: check it out;
    * issue has multiple linked branches: fail and ask Project Owner to resolve ambiguity.

13. Source `entrypoint.d/` hooks — run each `.sh` file in `/usr/local/libexec/adda-dev-runtime/bootstrap/entrypoint.d/` in lexicographic order. Hooks are sourced (not subprocess) so they may export variables into the bootstrap environment. The `entrypoint.d/` directory is created by the Tier 1 Dockerfile and is always present; an empty directory is not an error.

14. Run Tier 3 repo init hook: execute `/workspace/.adda-init.sh` as a subprocess if it exists. Non-existence is not an error. See *Tier 3 — project* for the full init hook contract.

15. Write `~/.bashrc` with `PS1` and the propagated environment variables (`HTTP_PROXY`, `HTTPS_PROXY`, `http_proxy`, `https_proxy`, `NO_PROXY`, `no_proxy`, `GH_REPO`). Touch the bootstrap-complete marker at `/run/.adda_bootstrap_complete`. The marker is also touched by the EXIT trap installed in step 5 so it is created even when bootstrap fails, allowing the parallel interactive shell to open for live autopsy.

16. Print session summary.

17. Exec Docker image's CMD. Tier 1 defaults CMD to `/bin/bash`; Tier 2 and Tier 3 images may override CMD (Tier 2 typically sets it to the AI harness executable; Tier 3 may further customize it).

18. If CMD exits, drop to an interactive shell for inspection.

19. On final shell exit, print git status and unpushed commit trail.

#### Branch resolution

Branch lookup uses GitHub's first-class Issue branch linkage, not a naming convention. Implementation may use GitHub GraphQL to query linked branches.

The branch naming convention remains documentation. The entrypoint stays convention-agnostic.

---

### libexec structure

Scripts and executables are installed under `/usr/local/libexec/adda-dev-runtime/` and split into two subdirectories by purpose:

#### `bootstrap/` — startup scripts

Contains scripts that run during container startup: `entrypoint.sh`, the `entrypoint.d/` hook directory, and the interactive-shell helper. These scripts run during bootstrap, before the agent starts, and are not intended to be invoked by the agent.

#### `bin/` — runtime executables (agent-invokable)

Contains executables the agent may invoke during a session.

---

## Tier 2 — ADDA SDLC implementation

### Primary responsibility

Tier 2's primary responsibility is to implement the ADDA SDLC (see [adda-sdlc.md](https://github.com/nightjarrr/molim/blob/main/docs/adda-sdlc.md)) for a specific AI harness. The SDLC design — roles, phases, permissions, skills, and workflow — is defined in that document. Tier 2 translates it into a concrete, runnable implementation for its target platform.

### Infrastructure contract

From Tier 1's perspective, any Tier 2 image must satisfy the following:

**Image:** builds `FROM` a Tier 1 image. The launcher configuration for a Tier 2 image must preserve Tier 1's security model — no capability additions, no network bypass, no privilege escalation.

**Bootstrap hook:** delivers `entrypoint.d/` hooks to `/usr/local/libexec/adda-dev-runtime/bootstrap/entrypoint.d/`. Hooks are sourced by the Tier 1 entrypoint after core bootstrap completes (GitHub auth, clone, and branch resolution are done). Hooks are sourced — not subprocess — so they share the entrypoint's shell environment and may export variables downstream. A Tier 2 image with no hooks is valid; the `entrypoint.d/` directory is always present (guaranteed by Tier 1).

**CMD:** overrides Tier 1's default CMD (`/bin/bash`) to the AI harness executable, making the harness the primary process.

### entrypoint.d hook requirements

A Tier 2 `entrypoint.d/` hook should:

- Use Tier 1 helper functions (`require_env`, `require_tool`, `section`, `success`, `die`) for consistent output and failure handling.
- Validate AI-harness-specific environment variables using `require_env`.
- Validate that the AI harness binary is present using `require_tool`.
- Initialise the AI harness configuration in `$HOME` so that the AI harness is ready when CMD runs.

Hooks are named with a numeric prefix for explicit ordering (e.g. `10-<name>.sh`). Multiple hooks are sourced in lexicographic order.

### Runtime executables

A Tier 2 implementation may add executables to `/usr/local/libexec/adda-dev-runtime/bin/` and scripts to `/usr/local/libexec/adda-dev-runtime/bootstrap/`, following the same libexec structure defined in Tier 1. See *libexec structure* above.

### CMD convention

Tier 1 defaults CMD to `/bin/bash`. Tier 2 overrides CMD to its AI harness executable. The Tier 1 entrypoint execs CMD after bootstrap completes; if CMD exits, the entrypoint drops to an interactive bash shell for inspection.

---

## Tier 3 — project

### Repository layout

A Tier 3 project is a standard GitHub repository. The project's technology stack is entirely unconstrained by ADDA Dev Runtime or by Tier 1/2 infrastructure — it may use any language, framework, or tooling. Projects benefit from tools pre-installed in Tier 1 or Tier 2 (`git`, `gh`, `curl`, `jq`, `rg`, `fdfind`, Bun, and any harness-specific additions) but are not required to use them.

A Tier 3 project may carry any combination of the following ADDA elements. None are mandatory — bootstrap does not fail if any are absent.

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

The agent context file provides the agent with project-specific orientation: architecture, conventions, toolchain, repo layout. Its name is determined by the AI harness in use. It contains no SDLC methodology; that is inherited from the Tier 2 image. Elements marked `SDLC:` are defined by the ADDA SDLC design and are not Tier 2-specific.

### Init hook (`.adda-init.sh`)

`/workspace/.adda-init.sh`, if present in the repository root, is a repo-level lifecycle hook invoked as a subprocess by the runtime.

#### Discovery

The runtime discovers exactly `/workspace/.adda-init.sh`. No other hook file paths are recognized.

#### Invocation contexts

Guaranteed to run at bootstrap if present. Also invoked when the session switches to a different issue and a branch checkout is performed.

#### Environment

The hook inherits environment variables from the caller — GitHub auth, proxy settings, `BUN_VERSION`, and any variables exported by `entrypoint.d` hooks. Shell functions and sourced helpers from the caller are **not** available across the subprocess boundary.

#### Permitted use

- Install or update project dependencies (`bun install`, `uv sync`, etc.).
- Write files in `/workspace`.
- Exit non-zero to fail the calling operation.

#### Prohibited — modifying the runtime shell environment

`export` statements, PATH modifications, and shell option changes (`set -o` / `set +o`) are structurally ineffective across a subprocess boundary and are explicitly out of scope. Examples: `export PATH=...`, `export MY_VAR=...`. Such statements execute inside the hook's subprocess and have no effect on the caller's environment.

#### Standalone safety

The hook must:

- Declare its own `set -euo pipefail` — it does not inherit the caller's shell options.
- Use absolute paths — the working directory is not guaranteed.
- Not rely on shell helper functions from the caller.

#### Tool invocation in the hook

Install project tools as dependencies and invoke them via their ecosystem runner — for example, `bun run <tool>` for Node/Bun projects, `uv run <tool>` for Python/uv projects. Do not rely on the session PATH for tool invocation.

#### Failure semantics

A non-zero exit from the hook fails the calling operation. An absent hook is not an error.

### Optional Dockerfile

A Tier 3 Dockerfile builds `FROM` the Tier 2 image in use. When present, it gives the project the full capability set available to any tier in the stack:

- **OS-level tooling** — add language runtimes and tools not present in Tier 1 or Tier 2 (Python/uv, Go, Java, etc.).
- **`entrypoint.d/` hooks** — drop hooks into `/usr/local/libexec/adda-dev-runtime/bootstrap/entrypoint.d/` to run custom initialization during bootstrap.
- **CMD override** — customize the command that runs after bootstrap (e.g. to run the AI harness with project-specific parameters).
- **libexec extensions** — add executables to `bin/` or scripts to `bootstrap/` following the same libexec structure as Tier 1 and Tier 2.

Tier 1 ships Bun — TypeScript/Bun projects require no Dockerfile for tooling. Any other language runtime requires either a Tier 3 Dockerfile (clean, reproducible, fast startup) or bootstrapping via the init hook (acceptable for lightweight package installs; fragile for full language runtimes that must themselves be installed).

**Launcher target:** when the project carries no Dockerfile, the launcher configuration references the Tier 2 image as the runtime target. When a project Dockerfile is present and built, the launcher configuration references the project image instead — the Tier 2 image becomes an intermediate build stage.

---

## Image build and distribution

### Shared conventions

These conventions apply to any image in the tier stack that has a Dockerfile.

**Version pinning:** all tool versions are pinned via `ENV` variables in the Dockerfile. A version comment block at the top of each Dockerfile is the visible source of truth; bumps go through an explicit chore Issue.

**Base image pinning:** `FROM` lines are pinned to specific point releases, not rolling tags (e.g. `debian:12.11-slim`, not `debian:bookworm-slim`). The version comment block tracks the pin date. Exception: during cross-tier development, a Tier 2 feature branch may deliberately reference the Tier 1 `edge` tag as a floating target for testing against the latest Tier 1 main-branch changes before a release is cut.

**apt packages:** package versions are *not* pinned to specific apt version strings. Debian stable's release policy (security and critical bug-fix updates only within a minor release) is the structural pin. Pinning individual apt version strings would be brittle without improving reproducibility. Hadolint DL3008 is suppressed inline with a rationale comment.

**Dockerfile quality:** hadolint runs in CI on every Dockerfile change.

**TypeScript compilation:** Bun executables are compiled in a multi-stage build. A `bun-builder` stage compiles `.ts` source files to extensionless executables; the runtime stage copies only the compiled output and pruned `node_modules`.

**GHCR distribution:** production images are published to GHCR. Each build is tagged with its commit SHA for immutable reference.

**Runtime image identification:** two environment variables carry image identity into every running container:

| Variable | Set by | When empty |
|---|---|---|
| `ADDA_DEV_RUNTIME_IMAGE` | Launcher at run time (`-e` flag) | Not injected (container started without the launcher) |
| `ADDA_DEV_RUNTIME_IMAGE_COMMIT_SHA` | CI at build time (`--build-arg`) | Local builds |

Both are displayed during bootstrap and remain available for the session lifetime. Neither is required; absence is not an error. `ADDA_DEV_RUNTIME_IMAGE` is not baked into the image because the same layer can be referenced under multiple tags; `ADDA_DEV_RUNTIME_IMAGE_COMMIT_SHA` is baked because only CI holds the commit SHA at build time.

### Tier 1 image

Built from `adda-dev-runtime/Dockerfile`. Published as `ghcr.io/{owner}/adda-dev-runtime`.

Standard tags:

| Tag | Updated when | Purpose |
| --- | --- | --- |
| `edge` | Push to `main` | Most recent main-branch build, SHA-stamped |
| `latest` | Release tag push | Most recent versioned release |
| `v{X.Y.Z}` | Release tag push | Immutable versioned release |
| `{sha}` | Every CI build | Immutable commit-linked reference; primary intermediate tag |
| `ci` | Every CI build | Latest CI build (mutable; overwritten each run) |

### Tier 2 image

Built `FROM` a Tier 1 image. The `BASE_TAG` build argument pins the exact Tier 1 image used. Published under its own name (e.g. `ghcr.io/{owner}/proto-adda-dev-runtime`). Each Tier 2 implementation publishes independently using the same tag conventions as Tier 1.

See `docs/proto-adda.md` for proto-adda image specifics.

### Tier 3 image

Optional. Present only when the project needs OS-level tooling not in Tier 1. Built `FROM` the Tier 2 image. Published per the project's own CI if needed; not published to this repository's GHCR namespace.

---

## Explicit non-choices

### No VS Code Dev Containers extension

The workflow is terminal-first. IDE integration and host-container IPC sockets are not part of this design.

### No in-container firewall

Network isolation is not enforced by iptables inside the AI harness container. The container runs with `--network none`; the Envoy sidecar enforces allowed destinations.

### No `NET_ADMIN` capability in the AI harness container

The container gets `--cap-drop ALL` and no capability add-back for firewall manipulation.

### No host-wide daemon proxy

The proxy is per-session runtime infrastructure. It starts with the AI harness session and stops when the session exits.

### No Envoy inside the AI harness container

Envoy is a separate sidecar container. Running it inside the AI harness container would collapse the security boundary.

### No external off-host proxy requirement

The perimeter proxy runs on the same host as the AI harness container. The design does not require a corporate or remote proxy service.

### No general web-fetch egress from the AI harness container

Broad web fetch/research is deferred to a separate design. The baseline container remains narrowly networked.

### No host home directory mount

The container has no view of host configuration files, SSH keys, browser profiles, or personal state.

### No SSH agent forwarding

GitHub access is via HTTPS using a fine-grained GitHub Token scoped to the project repository.

### No persistent AI harness config volume

AI harness state is ephemeral. Credentials are injected at startup and not preserved as a host-mounted config directory.

### No Docker socket inside the container

Mounting `/var/run/docker.sock` would be equivalent to host escape.

### No git worktrees on the host

Each session clones into an isolated in-container `/workspace`.

### No save-on-exit

The container exits with `--rm`; uncommitted work is lost. The SDLC's commit-and-push discipline bounds this risk.

### No multi-container per-subagent isolation

Subagents share one container per feature. Per-role separation is enforced by AI harness permissions, not container boundaries.

### No host-side `gh` or `git` dependency

GitHub-aware operations happen inside the container.

### No floating dependency versions

All external dependencies are pinned. Floating versions let upstream changes enter the environment without review — this policy eliminates that risk. Pinning operates at three layers:

1. **Application and tool versions** — exact versions are pinned in the Dockerfile via `ENV` variables and hard-coded curl download URLs. The version comment block at the top of each Dockerfile is the single visible source of truth; bumps go through an explicit chore Issue.

2. **Base image** — `FROM` lines are pinned to specific point releases rather than rolling tags. The version comment block tracks the pin date; bumping requires an explicit chore Issue.

3. **apt-installed packages** — package versions are *not* pinned to specific apt version strings. See shared image build conventions above.

---

## Deferred questions and features of the design

The following are recognized but not part of the immediate baseline implementation:

1. **Broad web retrieval plane** — define how user-approved direct URL fetch and research should work without opening general egress from the container.
2. **Live allow-list management** — explore whether Envoy policy should be reloadable without sidecar restart, and whether a UI/control plane is justified.
3. **Credential hiding behind proxy/gateway** — investigate whether future API-specific gateways can inject auth headers so selected tools do not receive raw tokens.
4. **Stronger sandboxing** — evaluate gVisor or VM isolation if kernel escape risk becomes a higher priority.
5. **Container resource limits** — CPU, memory, and disk quotas for the AI harness container are not currently enforced by the launcher. Evaluate `--memory`, `--cpus`, and cgroup-based limits.
