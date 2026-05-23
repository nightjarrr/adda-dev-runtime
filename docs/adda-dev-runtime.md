# Claude Code development environment

This document specifies the target design of an isolated, ephemeral, hardened container environment for running **Claude Code** against a GitHub-hosted project repository. It covers the image, the network perimeter, the container lifecycle, and the host-side and container-side scripts that bootstrap the environment.

Companion to [`adda-sdlc.md`](adda-sdlc.md).

**Audience: human Project Owner only.** Read at setup time and when modifying the environment. Not part of any agent's runtime context.

Throughout, `{owner}` and `{repo}` refer to the GitHub namespace and repository name of the project.

---

## Host system

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
* `claude`
* Python, Node, uv, or any project-specific runtime tooling

Those tools live inside containers.

---

## Principles

### Ephemeral runtime

A Claude dev runtime exists for one feature workflow and is destroyed on exit. The only durable project state is state intentionally pushed or written to GitHub: code, documentation, branches, commits, pull requests, Issues, labels, and comments. Anything not pushed before exit is lost. This is an intentional and accepted trade-off for isolation and reproducibility.

### Stateless agent, stateful world

Claude Code rebuilds context at session start by reading GitHub state and repository artifacts. No agent runtime state is carried across container exits.

### Defense in depth

Three concentric boundaries protect the host and project from code running inside the development environment:

1. **Container isolation** — the Claude container has no host filesystem, process, device, display, Docker socket, or network namespace access beyond what the launcher explicitly grants.
2. **Proxy-based network perimeter** — the Claude container runs with `--network none`. All intended outbound traffic goes through a launcher-managed Envoy sidecar proxy over a mounted Unix domain socket. Envoy enforces a default-deny domain allow-list.
3. **Claude permission system** — Claude Code's agent, skill, and tool restrictions enforce the SDLC's permission matrix inside the container.

Two further protections bound the impact of credential exposure:

* **Host-side keyring** — authentication tokens never reside in plaintext on host disk; the keyring is encrypted at rest and unlocked only by an active login session.
* **Token scoping** — the GitHub Token is recommended to be scoped to a single repository with no administration permissions, bounding Github blast radius.

### Host launcher and Envoy are trusted perimeter components

The Claude container is treated as untrusted. Nothing inside it is assumed to be non-exploitable. The host launcher and the per-session Envoy sidecar are therefore part of the trusted computing base for network and runtime isolation. A user who deliberately bypasses the launcher or weakens the Envoy policy is outside the protection model.

### Push-oriented persistence

The durable persistence storage for project work is GitHub. The intended project-state path is commit and push to the feature branch, plus Issue/PR updates through GitHub APIs. No host source bind mount, no persistent `~/.claude` volume, no SSH agent forwarding, and no shared host clone are used.

### No plaintext secrets on host disk

Authentication tokens live in the host Secret Service keyring. The launcher retrieves tokens on demand. There is no project `.env` containing secrets, no credentials file, and no token in shell history.

---

## Threat model

### Primary threat: host compromise from code inside the development environment

The environment must prevent any code, tool, dependency, or AI agent running inside the Claude dev container from affecting the host system.

Non-negotiable constraints:

* No `claude` install on the host.
* No host home directory mount.
* No host project source bind mount.
* No persistent `~/.claude` volume.
* No Docker socket inside the container.
* No shared host namespaces: no `--privileged`, no `--network=host`, no `--pid=host`, no `--ipc=host`.
* No host display forwarding: no `DISPLAY`, no X11 socket, no Wayland socket.
* No SSH agent forwarding.
* No general container network egress.
* Non-root user inside the Claude container.
* `--cap-drop ALL` for the Claude container.
* No capability add-back for the Claude container.
* `--security-opt no-new-privileges` to block setuid/file-capability privilege gain.
* Read-only root filesystem with explicit tmpfs mounts for writable runtime paths.

Normal copy/paste between Claude's TUI and the host is mediated by the terminal emulator. In-container processes do not receive programmatic access to the host GUI clipboard.

### Limits of container isolation

Container isolation reduces likelihood and blast radius; it does not reduce risk to zero. The host kernel must be patched. Image provenance, base-image discipline, pinned digests, CI provenance, and minimal runtime privileges are part of the mitigation. A determined attacker exploiting an unpatched container escape CVE is outside of this design's guarantee.

### Prompt injection

Adversarial content may reach Claude's context through web pages, dependency READMEs, Issue bodies, PR comments, fetched files, or repository content.

Recognized mitigations:

* Ephemeral runtime limits persistence and blast radius.
* Narrow GitHub Token scope prevents cross-repository or account-level damage.
* Claude Code permission configuration enforces the SDLC permission matrix.
* Network egress allow-list limits where compromised code can communicate.
* PR review remains the final human gate for code and workflow changes.

Residual risk: hostile content may influence changes on the current branch until caught at review.

### Malicious dependencies

A dependency may execute hostile code during install, test, build, or runtime.

The design distinguishes two dependency classes:

- **Container/toolchain dependencies** — OS packages, shell tools, language managers, `uv`, Node tooling, Claude Code, GitHub CLI, `socat`, and other infrastructure needed before the repository is cloned. These are baked into the image at build time and are not installed with root privileges at runtime.
- **Project code dependencies** — dependencies declared by the repository after it is cloned, such as Python packages in `pyproject.toml` / `uv.lock`, Node packages in `package.json` / lockfiles, or analogous ecosystem dependencies. These may need package-registry access at runtime because the repository is not available during generic base-image build.

Target-state mitigations:

- Project dependencies are lockfile-pinned and installed with frozen/locked resolution.
- Package-registry access is allowed only to explicit ecosystem registry domains required by the project bootstrap.
- OS-level/package-manager installation such as `apt install` is not performed at runtime.
- Runtime installs run as the unprivileged container user and write only to ephemeral tmpfs-backed paths.
- Dependabot and PR review govern dependency changes.

Residual risk: a malicious version already present in a reviewed lockfile can still execute inside the isolated container.

### Network exfiltration

A compromised tool or manipulated Claude may try to send repository contents, tokens, or other data to an attacker-controlled endpoint.

Primary mitigation: the Claude container has no network interface beyond loopback. Proxy-aware traffic reaches the network only through the Envoy sidecar. Envoy enforces a default-deny domain allow-list.

A process that ignores `HTTP_PROXY` / `HTTPS_PROXY` or opens raw sockets directly should fail because the container runs with `--network none`.

### Token theft

An attacker inside the Claude container may read tokens available to that process.

Recognized. The container must hold credentials or credential material to function. Mitigations:

* GitHub Token is single-repository and has no administration permissions.
* Claude OAuth token is revocable.
* The GitHub token is used for `gh auth login` and then removed from the process environment before handing off to Claude Code, where practical.
* Exfiltration routes are constrained by Envoy's allow-list.
* Tokens are never stored in plaintext on host disk.

Accepted residual risk: an attacker in a live session can use available credentials within their granted scope until the session is terminated or tokens are revoked.

### Quota and resource abuse

A runaway Claude session or hostile instruction may consume Anthropic quota, GitHub API rate limits, CPU, memory, or disk.

Mitigations:

* Ephemeral teardown stops further consumption.
* Container resource limits should be applied by the launcher.
* `tmpfs` sizes bound writable in-memory filesystem growth.
* GitHub API rate limits naturally apply to the token.

---

## Container and session model

One Claude development session corresponds to one isolated Claude container and one dedicated network perimeter sidecar.

| Concept                  | Mapping                         |
| ------------------------ | ------------------------------- |
| One GitHub Issue         | One feature workflow            |
| One feature workflow     | One Claude Code session         |
| One Claude Code session  | One `claude` process            |
| One `claude` process     | One Claude dev container        |
| One Claude dev container | One Envoy sidecar proxy         |
| One Claude dev container | One host `tmux` session |

Claude Code subagents run inside the parent `claude` process. They do not get separate containers.

### Lifecycle

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
5. Launcher starts the Claude dev container with `--network none` and the Envoy socket mounted into it.
6. Entrypoint starts an in-container `socat` bridge from loopback TCP to the mounted Unix socket.
7. Entrypoint configures GitHub auth, clone, branch selection, Claude config, and project bootstrap.
8. Entrypoint runs Claude Code or the command override.
9. On exit, launcher stops Envoy and removes the runtime directory.

### Concurrency

Multiple features may run concurrently. Each invocation gets its own Claude container, Envoy sidecar, runtime directory, Unix socket, and tmux session. Containers share no state with each other except through GitHub.

### TUI requirements

Claude Code is a TUI. The container provides a real PTY (`docker run -it`), `TERM=xterm-256color` or compatible behavior, and a UTF-8 locale.

Micro is installed as the default TUI editor (`EDITOR=micro`, `VISUAL=micro`). It is available for interactive file editing and is the fallback editor for CLI tools that open `$EDITOR` (e.g. `git commit`, `gh pr create`).

delta is installed as the git diff pager. All `git diff`, `git show`, `git log -p`, and `git add -p` output is automatically routed through delta for syntax highlighting, line numbers, and hunk navigation (n/N).

### Survivability

The launcher creates a named host `tmux` session and re-enters itself inside that session. This keeps the launcher, Envoy sidecar lifecycle, and `docker run` under tmux control. If the terminal emulator crashes or closes, the tmux server keeps the session alive. Reattach using the printed tmux session name.

The launcher also opens a `adda-dev shell` window (interactive bash in the ADDA Dev Runtime container) and a `adda-dev envoy logs` window (`docker logs -f` on the Envoy sidecar) in the same session.

---

## Authentication

Two secrets are required:

* Claude Code OAuth token for Anthropic API access.
* GitHub Token for repository access.

Both are stored in the host Secret Service keyring, retrieved by the launcher, and injected into the container at startup.

### Secret naming in keyring

| Secret                  | Service      | Account    | Key                               |
| ----------------------- | ------------ | ---------- | --------------------------------- |
| Claude Code OAuth token | `adda-dev` | `claude`   | `oauth` (default)                 |
| GitHub Token            | `adda-dev` | `github`   | repo-specific (e.g. `acme-token`) |
| DeepSeek API key        | `adda-dev` | `deepseek` | `apikey` (default)                |

All entries use the `adda-dev` service namespace. `account` identifies the target system; `key` identifies the credential within that system and is configured per-repo in `adda-dev.env` via `ADDA_DEV_KEYRING_GITHUB_KEY`, `ADDA_DEV_KEYRING_CLAUDE_KEY`, and `ADDA_DEV_KEYRING_DEEPSEEK_KEY`. Multiple GitHub repos can coexist in one keyring by using distinct `key` values (e.g., `acme-token`, `otherrepo-token`).

### One-time bootstrap: Claude Code OAuth token

Acquire the token using a throwaway container:

```bash
docker run --rm -it node:20 \
  sh -c "npm install -g @anthropic-ai/claude-code && claude setup-token"
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

Replace `{repo}` with the actual repository name (e.g., `acme`). The `{repo}-token` value must match `ADDA_DEV_KEYRING_GITHUB_KEY` in that repo's `adda-dev.env`. Using distinct values per repo enables simultaneous sessions against different repositories from the same keyring.

Github token scoping and permissions are explained further in **GitHub Token scoping** section.

### Retrieval

The launcher retrieves both tokens at runtime:

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

## Network policy

### Target architecture

The Claude container has no general network interface:

```text
Claude container (--network none)
  -> loopback HTTP proxy endpoint
  -> in-container socat bridge
  -> mounted Unix domain socket
  -> Envoy sidecar proxy
  -> allowed internet destinations
```

The network perimeter is outside the Claude container. Nothing inside the untrusted Claude container is able to enforce its own network rules.

### Claude container networking

The Claude container is launched with:

```bash
--network none
```

Expected properties:

* Only loopback is available inside the container.
* There is no default route.
* Direct DNS resolution to internet resolvers is unavailable.
* Direct TCP connections to internet IPs fail.
* Tools that ignore proxy settings fail to reach the network.

### Proxy bridge

Most applications understand HTTP proxies as `host:port`, not Unix sockets. The entrypoint therefore starts `socat` bridge inside the Claude container:

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

### Envoy sidecar

Envoy runs as a separate sidecar container managed by the launcher. It is not inside the Claude container.

Envoy responsibilities:

* Listen on a Unix domain socket.
* Accept explicit HTTP proxy traffic.
* Support plain HTTP forwarding.
* Support HTTPS `CONNECT` tunneling.
* Enforce domain allow-list / default-deny policy using RBAC.
* Resolve allowed upstream domains.
* Emit access logs for audit/debugging.
* Expose an admin interface on container loopback for diagnostics; it is not published to the host and is accessible via `docker exec`.

Envoy is per-session. One Claude container gets one Envoy sidecar.

### Envoy admin interface

The Envoy admin interface is bound to container loopback (`127.0.0.1:9901`) and is not published to any host port. Parallel Envoy sidecars can coexist without port conflicts.

To access the admin interface for diagnostics, use `docker exec` into the named Envoy container:

```bash
docker exec adda-dev-envoy-<RUN_ID> curl -s http://localhost:9901/ready
docker exec adda-dev-envoy-<RUN_ID> curl -s http://localhost:9901/stats
docker exec adda-dev-envoy-<RUN_ID> curl -s http://localhost:9901/listeners
```

It is for diagnostics only: readiness, stats, listeners, clusters, config dump, and troubleshooting. It is not a policy editing UI and must not be exposed to untrusted networks.

**Future:** when allow-list enforcement and WebFetch/WebSearch handling are implemented, revisit whether to publish the admin interface to host loopback for operational use.

### Allow-list

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
- Registry access must be explicit, ecosystem-specific, and lockfile/frozen-mode based. Examples: PyPI domains for Python/uv projects, npm registry domains for Node projects, or equivalent domains for other ecosystems.
- OS package registries such as Ubuntu/Debian APT mirrors are not allowed in the Claude runtime container.

Target-state non-goals for runtime allow-list:

- `ghcr.io` is not required inside the Claude container. The host launcher pulls the image.
- Arbitrary direct web fetch is not part of the baseline network policy.

### DNS

The Claude container does not resolve internet destinations for proxied traffic. It only connects to loopback. Envoy receives the requested authority from the explicit proxy request and resolves allowed destinations from the sidecar container.

Policy should be applied before DNS resolution and before upstream connection.

### Failure handling

Target-state behavior:

* If Envoy cannot start, the launcher fails before starting the Claude container.
* If the Unix socket does not appear, the launcher fails.
* If the in-container `socat` bridge cannot start, the entrypoint fails.
* If a request does not match the allow-list, Envoy denies it.
* If a process bypasses proxy configuration, it has no network path due to `--network none`.

### Broad web research / Web Fetch

Direct URL fetching and broad internet research are recognized as a separate capability class. They conflict with a narrow runtime allow-list if executed inside the Claude dev container.

Target-state baseline: do not open general internet egress from the Claude container for this use case.

Future design work: define a separate retrieval plane or tool boundary for user-approved web research/fetch, isolated from the writable project container and credentials.

---

## Filesystem and process hardening

### Claude container process privileges

The Claude container is launched with:

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

The Claude container root filesystem is read-only:

```bash
docker run --read-only
```

Writable paths are explicit tmpfs mounts. The design assumes a single effective runtime user inside the Claude container. Writable mounts are owned by that runtime UID/GID and are private by default.

### Runtime user configuration

The launcher/project configuration defines:

```bash
ADDA_DEV_USER=adda
ADDA_DEV_UID=1000
ADDA_DEV_GID=1000
ADDA_DEV_HOME=/home/adda
```

The image must run as that user, or the entrypoint should warn that runtime UID/GID do not match the expected configuration.

### Writable tmpfs mounts

Target writable mounts:

| Path                 | Mode   | Exec?             | Purpose                                                                     |
| -------------------- | ------ | ----------------- | --------------------------------------------------------------------------- |
| `/home/${ADDA_DEV_USER}` | `0700` | yes               | Claude state, gh config, git config, uv/Python runtime state, shell config. |
| `/workspace`         | `0700` | yes               | Repository checkout, project writes, test/build output.                     |
| `/tmp`               | `0700` | no | Temporary files.                                                            |
| `/var/tmp`           | `0700` | no | Temporary files for tools that use `/var/tmp`.                              |
| `/run`               | `0700` | no                | Runtime files and mounted proxy socket.                                     |

`$HOME` and `/workspace` must permit execution because language tooling may install executable interpreters, virtualenvs, or scripts there.

`/run` should be `noexec`; it exists for runtime/socket files.

Tmpfs sizes are configured by project/launcher variables, for example:

```bash
ADDA_DEV_HOME_TMPFS_SIZE=500m
ADDA_DEV_WORKSPACE_TMPFS_SIZE=200m
```

Sizes are limits, not pre-allocated RAM reservations. Linux tmpfs consumes host memory/swap according to actual usage.

### Proxy socket mount

The Envoy Unix socket is bind-mounted into the Claude container as an immediate child of `/run`, for example:

```text
/run/proxy.sock
```

This avoids relying on nested parent directories under a tmpfs-mounted `/run`.

The socket file itself is created by Envoy in the launcher runtime directory. Socket permissions must allow the Claude runtime user to connect despite possible UID/GID mismatch between host user, Envoy sidecar process, and Claude container user. The private per-run host runtime directory plus narrow socket bind mount form the main access boundary.

### Expected Docker-managed mounts

Docker may still provide managed files such as:

* `/etc/hosts`
* `/etc/hostname`
* `/etc/resolv.conf`

These do not by themselves provide network access. They should be treated as expected Docker runtime configuration files unless they contain unexpected content.

---

## Repository layout

The harness lives in the project repository.

```text
.devcontainer/
  adda-dev-runtime/
    Dockerfile                       # Claude dev image definition
    entrypoint.sh                    # in-container bootstrap/orchestration
    .claude.json.template            # Claude Code configuration template 
  envoy/
    envoy.yaml.template              # Envoy sidecar forward-proxy config template
  image.digest                       # pinned digest of published dev image, target-state

.claude/
  ...                                # Claude Code project configuration

scripts/
  adda-dev.sh                      # host-side launcher
  adda-dev.env                     # host side launcher configuration (per-project)
  adda-dev.tmux.conf               # seed tmux config, copied only if ~/.tmux.conf is absent

.github/workflows/
  devenv.yml                         # target-state image build/publish workflow
```

Harness changes follow the project's regular SDLC as `chore` Issues.

---

## Image build and distribution

### Target state

The dev image is built by CI and hosted on GHCR:

```text
ghcr.io/{owner}/{repo}-devenv
```

The launcher does not rely on floating tags. It pulls the digest stored in `.devcontainer/image.digest`.

Target tags:

| Tag              | Updated when                          | Purpose                            |
| ---------------- | ------------------------------------- | ---------------------------------- |
| `latest`         | Push to `main` touching harness paths | Most recent stable build.          |
| `sha-{shortsha}` | Every build                           | Immutable commit-linked reference. |
| `weekly-{date}`  | Scheduled weekly                      | Security refresh rebuild.          |
| `pr-{n}`         | PRs touching harness paths            | Verification only.                 |

---

## Launcher script (`adda-dev.sh`)

Host-side script. Its job is to create one ephemeral Claude dev runtime.

Invocation:

```bash
adda-dev.sh
adda-dev.sh <issue-id>
adda-dev.sh -- <cmd> [args...]
adda-dev.sh <issue-id> -- <cmd> [args...]
```

### Per-project configuration

The launcher reads `scripts/adda-dev.env`.

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

### Behavior

1. Validate arguments.
2. Verify host prerequisites: `docker`, `secret-tool`, `tmux`, `openssl`.
3. Source `adda-dev.env` and validate required variables.
4. Seed `~/.tmux.conf` from `scripts/adda-dev.tmux.conf` only if missing; source it best-effort.
5. If not already inside tmux, generate a session name, export it, and re-enter the launcher inside a named tmux session.
6. Retrieve auth tokens from Secret Service keyring.
7. Detect host timezone.
8. Create a private per-run runtime directory under `${XDG_RUNTIME_DIR:-/tmp}`.
9. Render Envoy config from `.devcontainer/envoy/envoy.yaml.template` into the runtime directory.
10. Start Envoy sidecar container with hardened flags.
11. Wait for the Envoy Unix socket.
12. Create `adda-dev shell` and `adda-dev envoy logs` windows in the primary tmux session.
13. Assemble and run the Claude dev container with:

    * `--rm -it`
    * `--network none`
    * `--cap-drop ALL`
    * `--security-opt no-new-privileges`
    * `--read-only`
    * explicit tmpfs mounts
    * Envoy socket bind mount
    * required environment variables
14. On exit, stop Envoy and remove the runtime directory.

### Envoy sidecar hardening

Envoy sidecar is outside the Claude trust boundary but should still be minimized:

* exact image version and digest in target state;
* `--rm -d`;
* `--cap-drop ALL`;
* `--security-opt no-new-privileges`;
* read-only root where compatible;
* tmpfs for `/tmp`;
* admin interface not published to host; accessible via `docker exec` only.

---

## Entrypoint script (`entrypoint.sh`)

Container-side script. It validates the runtime contract, starts the local proxy bridge, bootstraps the repository, and hands off to Claude Code or command override.

### Behavior

1. Print welcome banner.

2. Validate required environment variables.

3. Configure Bash prompt to identify the container context, for example:

   ```text
   [adda-dev {repo} #{issue}] /workspace$
   ```

4. Verify `/workspace` is empty.

5. Report diagnostic hardening checks:

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

13. Initialize Claude Code configuration in `$HOME`.

14. Run project-specific bootstrap steps (e.g., in case of `uv` and Python project this can be `uv sync --frozen`).

15. Print session summary.

16. Run Docker image's CMD, `claude` by default.

17. If CMD exits, drop to an interactive shell for inspection.

18. On final shell exit, print git status and unpushed commit trail.

### Branch resolution

Branch lookup uses GitHub's first-class Issue branch linkage, not a naming convention. Implementation may use GitHub GraphQL to query linked branches.

The branch naming convention remains documentation. The entrypoint stays convention-agnostic.

### Base/project split

Long-term structure should separate:

* base Claude dev runtime behavior;
* project-specific bootstrap steps.

The base image should own validation, hardening diagnostics, proxy bridge, GitHub auth, clone, branch resolution, Claude config, and handoff. The project layer should own dependency installation and project-specific checks.

---

## Terminal emulator and tmux

### Ghostty

Ghostty is the preferred terminal emulator. Increase host terminal scrollback if desired:

```text
scrollback-limit = 100000000
```

### tmux

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

## Explicit non-choices

### No VS Code Dev Containers extension

The workflow is terminal-first. IDE integration and host-container IPC sockets are not part of this design.

### No in-container firewall

Network isolation is not enforced by iptables inside the Claude container. The Claude container runs with `--network none`; Envoy sidecar enforces allowed destinations.

### No `NET_ADMIN` capability in Claude container

The Claude container gets `--cap-drop ALL` and no capability add-back for firewall manipulation.

### No host-wide daemon proxy

The proxy is per-session runtime infrastructure. It starts with the Claude session and stops when the Claude session exits.

### No Envoy inside the Claude container

Envoy is a separate sidecar container. Running it inside the Claude container would collapse the security boundary.

### No external off-host proxy requirement

The perimeter proxy runs on the same host as the Claude container. The design does not require a corporate or remote proxy service.

### No general web-fetch egress from the Claude container

Broad web fetch/research is deferred to a separate design. The baseline dev container remains narrowly networked.

### No host home directory mount

The container has no view of host configuration files, SSH keys, browser profiles, or personal state.

### No SSH agent forwarding

GitHub access is via HTTPS using a fine-grained GitHub Token scoped to the project repository.

### No persistent `~/.claude` volume

Claude state is ephemeral. Credentials are injected at startup and not preserved as a host-mounted Claude directory.

### No Docker socket inside the container

Mounting `/var/run/docker.sock` would be equivalent to host escape.

### No git worktrees on the host

Each session clones into an isolated in-container `/workspace`.

### No save-on-exit

The container exits with `--rm`; uncommitted work is lost. The SDLC's commit-and-push discipline bounds this risk.

### No multi-container per-subagent isolation

Claude Code subagents share one container per feature. Per-role separation is enforced by Claude Code permissions, not container boundaries.

### No host-side `gh` or `git` dependency

GitHub-aware operations happen inside the container.

### No floating dependency versions

All external dependencies are pinned. Floating versions let upstream changes enter the environment without review — this policy eliminates that risk. Pinning operates at three layers:

1. **Application and tool versions** — exact versions are pinned in the Dockerfile via `ENV` variables and hard-coded curl download URLs (GitHub CLI, Micro, Delta, Node.js, Claude Code). The version comment block at the top of `docker/adda-dev-runtime/Dockerfile` is the single visible source of truth; bumps go through an explicit chore Issue.

2. **Base image** — the Tier 1 `FROM` line is pinned to the current Debian 12 point release (`debian:12.11-slim`) rather than the rolling `debian:bookworm-slim` tag. The version comment block tracks the pin date; bumping requires an explicit chore Issue.

3. **apt-installed packages** — package versions are *not* pinned to specific apt version strings. Debian stable's release policy is itself the structural pin: packages in `stable` only receive security and critical bug-fix updates within a minor release cycle, making the distribution the effective version anchor. Pinning individual apt package versions would be brittle (version strings differ between architectures and snapshot dates) without meaningfully improving reproducibility. Hadolint DL3008 is suppressed inline with a rationale comment for this reason.

---

## Deferred questions and features of the design

The following are recognized but not part of the immediate baseline implementation:

1. **Broad web retrieval plane** — define how user-approved direct URL fetch and research should work without opening general egress from the Claude dev container.
2. **Live allow-list management** — explore whether Envoy policy should be reloadable without sidecar restart, and whether a UI/control plane is justified.
3. **Credential hiding behind proxy/gateway** — investigate whether future API-specific gateways can inject auth headers so selected tools do not receive raw tokens.
4. **Base/project entrypoint split** — extract generic Claude dev runtime logic into a reusable base layer and project-specific bootstrap into hooks.
5. **Image provenance hardening** — complete GHCR publishing, digest pinning, provenance, and scheduled rebuild workflow.
6. **Stronger sandboxing** — evaluate gVisor or VM isolation if kernel escape risk becomes a higher priority.
