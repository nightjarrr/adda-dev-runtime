# ADDA Dev Runtime — Technical Design

This document is the technical complement to [`docs/adda-dev-runtime-design.md`](adda-dev-runtime-design.md). It describes the container-internal implementation — entrypoint sequence, bootstrap extension points, artifact routing, and image build pipeline.

**Audience: human Project Owner only.** Read when implementing, extending, or debugging the runtime. Not part of any agent's runtime context.

For the host-side implementation — launcher behavior, Envoy sidecar, network enforcement, and authentication — see [`docs/technical-design.md`](https://github.com/nightjarrr/adda-dev-launcher/blob/main/docs/technical-design.md) in `adda-dev-launcher`.

Throughout, `{owner}` and `{repo}` refer to the GitHub namespace and repository name of the project.

---

## Technology stack

This section maps the technology-agnostic concepts from the conceptual design to the specific technologies used in this implementation.

| Concept | Technology |
|---|---|
| Tier 1 scripting runtime | Bun |
| Container image registry | GitHub Container Registry (GHCR) |
| Project hosting, issues, PRs, CI/CD | GitHub + GitHub Actions |

---

## Tier 1

### TUI environment

The AI harness is a TUI application. It runs in a PTY allocated by `docker run -it`, with `TERM=xterm-256color` or compatible behavior and a UTF-8 locale.

Micro is installed as the default TUI editor (`EDITOR=micro`, `VISUAL=micro`). It is available for interactive file editing and is the fallback editor for CLI tools that open `$EDITOR` (e.g. `git commit`, `gh pr create`).

delta is installed as the git diff pager. All `git diff`, `git show`, `git log -p`, and `git add -p` output is automatically routed through delta for syntax highlighting, line numbers, and hunk navigation (n/N).

### Scripting runtime

Bun is included in Tier 1 as the shared scripting runtime for infrastructure tools. Scripts that need structured argument parsing, typed logic, or external API calls are implemented as Bun TypeScript executables rather than shell scripts, providing a consistent scripting environment across all tiers without requiring higher-tier setup.

Shell scripts remain in use for entrypoint glue and `entrypoint.d` hooks, which must participate directly in the entrypoint's shell environment.

TypeScript sources are compiled to extensionless JavaScript bundles with a `#!/usr/bin/env bun` shebang during the Docker image build. See *Image build and distribution* for build conventions.

### Entrypoint

Container-side script (`entrypoint.sh`). Validates the runtime contract, starts the proxy bridge, bootstraps the repository, sources `entrypoint.d/` hooks, runs the Tier 3 init hook if present, and hands off to CMD.

#### Behavior

1. Print welcome banner.

2. Validate §1.1 environment — see *Container contract*. Optionally display `ADDA_DEV_RUNTIME_IMAGE` and `ADDA_DEV_RUNTIME_IMAGE_COMMIT_SHA` when present.

3. Validate §1.2 filesystem — abort if `/workspace` is non-empty. See *Container contract*.

4. Report §1.3 hardening diagnostics. See *Container contract*.

5. Install bootstrap-complete marker EXIT trap. From this point on, any premature exit (failure or signal) touches `/run/.adda_bootstrap_complete` so the parallel interactive shell can open for autopsy.

6. Start `socat` bridge from `127.0.0.1:${ADDA_DEV_PROXY_PORT}` to `${ADDA_DEV_PROXY_SOCKET}`.

7. Export proxy environment variables:

   ```bash
   HTTP_PROXY=http://127.0.0.1:<port>
   HTTPS_PROXY=http://127.0.0.1:<port>
   http_proxy=http://127.0.0.1:<port>
   https_proxy=http://127.0.0.1:<port>
   NO_PROXY=localhost,127.0.0.1,::1
   no_proxy=localhost,127.0.0.1,::1
   ```

8. Configure GitHub authentication using `gh auth login --with-token`.

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

**Hook number convention:**
- **10–94**: Extension hooks — Tier 2 and Tier 3 Dockerfiles place `announce_shell_tool` calls and other setup here.
- **95**: Tier 1-owned gate — seals the announcement list and writes `/run/adda/.adda-shell-tools.jsonl`. Must not be overridden or reused.
- **96–99**: Post-gate — the tool list is final. Tier 2/3 may render or process the registry but must not call `announce_shell_tool`.

Available helper functions (sourced from Tier 1):
- `require_env <VAR>` — fail with a clear message if the variable is unset or empty.
- `require_tool <cmd>` — fail with a clear message if the command is not found.
- `section <title>` — print a formatted section header.
- `success <msg>` — print a success line.
- `warning <msg>` — print a warning line (non-fatal).
- `die <msg>` — print an error and exit non-zero.
- `info <msg>` — print an informational line; use instead of bare `echo` in hooks.
- `announce_shell_tool <name> <cmd> <desc>` — register a CLI tool in the agent-visible shell tools registry; hooks numbered 10–94 call this to extend the registry before hook 95 seals it. Calling this after hook 95 is a fatal error.

All plain-text output in bootstrap scripts and hooks must use `info()` instead of bare `echo`. `info()` is hook-mode aware: in normal mode it prints a plain line; in hook mode it indents to align with the other hook-mode helpers.

The `entrypoint.d/` directory is created by the Tier 1 Dockerfile and is always present. An empty directory is not an error.

#### Shell tools registry

Agents running inside the container have no inherent knowledge of what CLI tools are installed. The shell tools registry is a mechanism for accumulating this information during bootstrap so that Tier 2 can render it into agent-facing guidance — steering agents toward tools that are present and away from familiar-but-absent alternatives.

**Announcing tools:**

The `announce_shell_tool <name> <cmd> <desc>` helper registers a tool entry in JSONL format:

```json
{"name":"rg","cmd":"rg <pattern> [path]","desc":"Fast text search — prefer over grep"}
```

Tier 1 announces its own tools during the entrypoint run. `entrypoint.d/` hooks may call `announce_shell_tool` at any hook number to extend the registry with tier-specific or project-specific tools.

**Writing the registry:**

Hook `95-write-shell-tools-registry.sh` is the Tier 1-owned gate. It runs after all extension hooks (10–94) have had the opportunity to call `announce_shell_tool`. The gate sets `_SHELL_TOOLS_SEALED="1"` to activate bidirectional guards, then writes `/run/adda/.adda-shell-tools.jsonl`. Any call to `announce_shell_tool` after hook 95 is a fatal error; any call to `list_shell_tools` before hook 95 is also a fatal error.

**Reading the registry:**

Tier 2 reads `/run/adda/.adda-shell-tools.jsonl` to obtain the complete tool list and format it into agent-facing guidance.

**Entry format:**

Each entry has three fields: `name` (tool identifier), `cmd` (canonical invocation syntax), and `desc` (one-line description, which may include "prefer over X" hints). Negative entries ("X is absent") are not used — the registry announces what is present; absence is implied.

### libexec layout

Scripts and executables are installed under `/usr/local/libexec/adda-dev-runtime/` and split into two subdirectories by purpose.

#### `bootstrap/` — startup scripts

Contains scripts that run during container startup: `entrypoint.sh`, the `entrypoint.d/` hook directory, and the interactive-shell helper. These scripts run before the agent starts and are not intended to be invoked by the agent.

#### `bin/` — runtime executables (agent-invokable)

Contains executables the agent may invoke during a session.

#### Artifact routing table

`<libexec>` expands to `/usr/local/libexec/adda-dev-runtime`:

```
Tier 1
  <libexec>/bootstrap/entrypoint.sh
  <libexec>/bootstrap/entrypoint.d/<h>.sh
  <libexec>/bootstrap/<name>
  <libexec>/bootstrap/<name>.sh
  <libexec>/bin/<name>
  <libexec>/bin/<name>.sh

Tier 2
  <libexec>/bootstrap/entrypoint.d/<h>.sh
  <libexec>/bootstrap/<name>
  <libexec>/bootstrap/<name>.sh
  <libexec>/bin/<name>
  <libexec>/bin/<name>.sh
```

### Image build and distribution

#### Shared conventions

These conventions apply to all images in the tier stack.

**Version pinning:** all tool versions are pinned via `ENV` variables in the Dockerfile. A version comment block at the top of each Dockerfile is the visible source of truth; bumps go through an explicit chore Issue.

**Base image pinning:** `FROM` lines are pinned to specific point releases, not rolling tags (e.g. `debian:12.11-slim`, not `debian:bookworm-slim`). Exception: during cross-tier development, a Tier 2 feature branch may deliberately reference the Tier 1 `edge` tag as a floating target for testing against the latest Tier 1 main-branch changes before a release is cut.

**apt packages:** package versions are *not* pinned to specific apt version strings. Debian stable's release policy (security and critical bug-fix updates only within a minor release) is the structural pin. Hadolint DL3008 is suppressed inline with a rationale comment.

**Dockerfile quality:** hadolint runs in CI on every Dockerfile change.

**SHELL pipefail:** All Dockerfiles set `SHELL ["/bin/bash", "-o", "pipefail"]` after each `FROM` in the runtime stage. This satisfies hadolint DL4006 and ensures that piped commands (e.g. `echo | sha256sum -c`) fail if *any* stage in the pipeline fails, not just the last. The directive applies to all subsequent `RUN` commands and does not affect build stages that use `/bin/sh`.

**TypeScript compilation:** TypeScript sources are compiled in a multi-stage build. A `bun-builder` stage bundles each `.ts` entry point to a single-file JavaScript with a `#!/usr/bin/env bun` shebang, then strips the `.js` extension to produce extensionless executables; the runtime stage copies only the compiled output and pruned `node_modules`.

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
| `edge` | Push to `main`, weekly Sunday 04:00 UTC | Most recent main-branch build, SHA-stamped |
| `latest` | Release tag push | Most recent versioned release |
| `v{X.Y.Z}` | Release tag push | Immutable versioned release |
| `{sha}` | Every CI build | Immutable commit-linked reference; primary intermediate tag |
| `ci` | Every CI build | Latest CI build (mutable; overwritten each run) |

**SLSA build provenance:** versioned release images (`:v{X.Y.Z}`, `:latest`) are attested with `actions/attest@v4` and the attestation pushed to GHCR. Consumers can verify provenance with:

```bash
gh attestation verify oci://ghcr.io/{owner}/adda-dev-runtime:{tag} --owner {owner}
gh attestation verify oci://ghcr.io/{owner}/proto-adda-dev-runtime:{tag} --owner {owner}
```

Each attestation is signed with a short-lived Sigstore certificate, logged in the Rekor transparency log, and links the image digest to the exact commit and workflow run that produced it.

---

## Tier 2

### Infrastructure contract

**Image:** builds `FROM` a Tier 1 image. The `BASE_TAG` build argument pins the exact Tier 1 image used. The launcher configuration for a Tier 2 image must preserve Tier 1's security model — no capability additions, no network bypass, no privilege escalation.

**Bootstrap hook:** delivers `entrypoint.d/` hooks to `/usr/local/libexec/adda-dev-runtime/bootstrap/entrypoint.d/`. Hooks are sourced by the Tier 1 entrypoint after core bootstrap completes. A Tier 2 image with no hooks is valid.

**CMD:** overrides Tier 1's default CMD (`/bin/bash`) to the AI harness executable, making the harness the primary process.

### `entrypoint.d` hook requirements

A Tier 2 `entrypoint.d/` hook is responsible for validating and initialising the AI harness environment. Use Tier 1 helper functions (`require_env`, `require_tool`, `section`, `success`, `die`, `info`) for consistent output and failure handling; use `info()` instead of bare `echo` for all plain-text output.

**Validation** (abort the hook on failure):
- Validate AI-harness-specific environment variables using `require_env`, including backend credentials selected by `ADDA_DEV_LLM_BACKEND`.
- Validate that the AI harness binary is present using `require_tool`.

**Initialisation**:
- Initialise the AI harness configuration in `$HOME` so that the harness is ready when CMD runs.

### Runtime executables and libexec additions

A Tier 2 implementation may add executables to `/usr/local/libexec/adda-dev-runtime/bin/` and scripts to `/usr/local/libexec/adda-dev-runtime/bootstrap/`, following the same libexec layout defined in Tier 1.

### Image build

Built `FROM` a Tier 1 image. Published under its own name (e.g. `ghcr.io/{owner}/proto-adda-dev-runtime`). Each Tier 2 implementation publishes independently using the same tag conventions as Tier 1.

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

### Image build

Optional. Present only when the project needs OS-level tooling not in Tier 1. Built `FROM` the Tier 2 image. Published per the project's own CI if needed; not published to this repository's GHCR namespace.

### Launcher target

When the project carries no Dockerfile, the launcher configuration references the Tier 2 image as the runtime target. When a project Dockerfile is present and built, the launcher configuration references the project image instead — the Tier 2 image becomes an intermediate build stage.

---

## Container contract

This section describes how the container stack validates the launcher's §1 obligations under the [launcher–container contract](launcher-container-contract.md). The contract specifies what each party owes the other and at what enforcement level; validation is split between the Tier 1 entrypoint and the Tier 2 hook.

### §1.1 Environment

Enforced variables cause an abort if absent; optional variables are used only when present.

| Variable | Level | Validated by | Action |
|---|---|---|---|
| `GITHUB_OWNER` | Enforced | Tier 1 entrypoint (step 2) | `require_env` — abort if absent |
| `GITHUB_REPO` | Enforced | Tier 1 entrypoint (step 2) | `require_env` — abort if absent |
| `GITHUB_TOKEN_` | Enforced | Tier 1 entrypoint (step 2) | `require_env` — abort if absent; consumed for `gh auth login --with-token` (step 8) then removed from the process environment (step 9) |
| `TZ` | Enforced | Tier 1 entrypoint (step 2) | `require_env` — abort if absent |
| `ADDA_DEV_PROXY_SOCKET` | Enforced | Tier 1 entrypoint (step 2) | `require_env` — abort if absent; socket existence verified when starting the proxy bridge (step 6) |
| `ADDA_DEV_PROXY_PORT` | Enforced | Tier 1 entrypoint (step 2) | `require_env` — abort if absent |
| `ADDA_DEV_LLM_BACKEND` | Enforced | Tier 1 entrypoint (step 2) | `require_env` — abort if absent |
| `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` | Enforced | Tier 1 entrypoint (step 2) | `require_env` — abort if absent |
| `ADDA_DEV_RUNTIME_IMAGE` | Optional | Tier 1 entrypoint (step 2) | Displayed in banner if present; absence is not an error |
| `ISSUE_ID` | Optional | Tier 1 entrypoint (step 2) | Drives branch resolution (step 12); absent means stay on `main` |
| Backend credential | Enforced | Tier 2 hook | `require_env` per `ADDA_DEV_LLM_BACKEND` — abort if absent |

### §1.2 Filesystem

Enforced checks abort; expected checks emit diagnostics but do not abort. All checks are performed by the Tier 1 entrypoint.

| Mount | Level | Check |
|---|---|---|
| `/workspace` | Enforced | Abort if non-empty (step 3); used for the repository clone (step 11) |
| `/workspace` | Expected | Diagnostic: tmpfs, writable, exec (step 4) |
| `/tmp` | Expected | Diagnostic: tmpfs, writable, exec (step 4) |
| `/home/adda` | Expected | Diagnostic: tmpfs, writable, exec (step 4) |
| `/run` | Expected | Diagnostic: tmpfs, writable, noexec (step 4) |
| Proxy socket at `ADDA_DEV_PROXY_SOCKET` | Enforced | Socket must exist — verified when `socat` starts the proxy bridge (step 6) |

### §1.3 Hardening

All checks are expected diagnostics performed by the Tier 1 entrypoint (step 4): warns on mismatch but does not abort. Enforcement is outside the container, applied by the launcher.

| Expected condition | Check |
|---|---|
| Loopback-only network | No default route; only loopback interface present |
| No effective capabilities | `CapEff: 0000000000000000` |
| No privilege escalation | `NoNewPrivs: 1` |
| Read-only root filesystem | No writable non-tmpfs mounts |
| Expected tmpfs mounts present | `/home/adda`, `/workspace`, `/tmp`, `/run` are tmpfs |
| `/home/adda` and `/workspace` executable | exec bit set |
| `/run` noexec | noexec mount option |

### §2 Container obligations

The contract has one SHOULD obligation on the container side: the image SHOULD provide an executable at `/usr/local/libexec/adda-dev-runtime/bootstrap/open-interactive-shell.sh`. The Tier 1 image fulfills this obligation — `open-interactive-shell.sh` is shipped at that path. The launcher `docker exec`s it to open an interactive shell window alongside the main session.
