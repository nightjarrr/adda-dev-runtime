# ADDA Dev Runtime

This repo *is* the dev runtime. Design and current state are in
`docs/adda-dev-runtime.md` and `docs/adda-dev-runtime-current-state.md`.

## Repo layout

- `adda-dev-runtime/` — Tier 1 base image (Dockerfile, content/scripts/).
- `proto-adda/` — Tier 2 AI-harness image. Adds Claude Code, the Claude
  config, and the `10-claude-config.sh` bootstrap hook.
- `launcher/` — host-side launcher script, config, and Envoy proxy template.

## Working on the runtime from inside the runtime

The Claude Code session that develops this repo runs in a proto-adda
container built from this same repo. Two consequences:

- **No Docker in the container.** Image builds and launch tests are run by
  PO on the host, not by the agent. Verification inside the container is
  limited to file/path checks and `quality-gates`.
- **`/workspace` is the only durable path.** See *Path model* below.

## Tier architecture

**Tier 1** (`adda-dev-runtime/`) — generic, AI-tool-agnostic base. Ships
container startup scripts under `/usr/local/libexec/adda-dev-runtime/bootstrap/`
(including `entrypoint.sh` and the `entrypoint.d/` hook directory), runtime tools
invokable by the agent under `/usr/local/libexec/adda-dev-runtime/bin/`, system
tools (git, gh, socat, rg, fdfind, etc.), and Bun, tsc, and Biome — making
TypeScript a first-class scripting language for Tier 1 scripts; see
`docs/bun-scripting-for-adda.md`. Note: `@types/bun` is **not** an image global —
it is a repo `devDependency` in `package.json`, installed at bootstrap time via
`.adda-init.sh`.

**Tier 2** (`proto-adda/`) — AI harness. Builds `FROM` Tier 1. Ships Claude
Code, the Claude config, and the `10-claude-config.sh` bootstrap hook.

## Repo-level init hook

`.adda-init.sh` in the repo root is sourced by the entrypoint at bootstrap time,
after all image-defined `entrypoint.d` hooks and before CMD handoff.

**What it does in this repo:**

- Reads `@types/bun` version from `package.json` and compares it to `$BUN_VERSION`
  (the version baked into the image).
- **Match:** runs `bun install --frozen-lockfile`.
- **Mismatch:** runs `bun add --dev "@types/bun@${BUN_VERSION}"` to auto-correct,
  then writes `/workspace/CLAUDE.local.md` with exact versions and a
  ready-to-paste commit message.

**Lockfile:** `bun.lock` (text format, Bun 1.3.14 default) is committed to the
repo. The `--frozen-lockfile` flag keeps it authoritative on the happy path.

**Session start signal:** if `package.json` and/or `bun.lock` are dirty at the
start of a session with an `@types/bun` version change, the init hook auto-corrected
a version mismatch. Check `CLAUDE.local.md` for details and the commit command.

## Script placement decision model

When adding a new script, use these four axes to determine where it goes:

0. **Host vs Container**: if the script runs on the host, it lives in `launcher/`
   and this decision model does not apply. If it runs inside the container,
   proceed to axes 1–3.

1. **Tier**: Tier 1 (`adda-dev-runtime/`) if generic and AI-tool-agnostic, or if
   the script modifies the bootstrap/entrypoint process itself (rather than
   extending it via a hook or other extensibility point); Tier 2 (`proto-adda/`)
   if harness- or project-specific.

2. **bootstrap vs bin vs build**: `bootstrap/` if the script runs during container startup
   (entrypoint, hook, interactive-shell helper) and must **not** be agent-invokable;
   `bin/` if the script is invokable by the agent at runtime;
   `adda-dev-runtime/build/` if the script runs only during Docker image *build* (e.g.,
   post-processing build artifacts) and must **not** be present in any image.

3. **Shell vs Bun**: shell (`.sh.source`) if it is simple glue, needs to source the
   environment, or is part of the hook chain; Bun (`.ts`) if it needs structured
   argument parsing, typed logic, external API calls, or testability.

## Toolchain

Bun, Biome, and tsc are pre-installed globals. Never use `bunx` for any of
them — `bunx` downloads on demand and risks version mismatches.

Correct invocations:

- `bun test --coverage --coverage-reporter=lcov --coverage-reporter=text --coverage-dir=<output dir>`
- `bun build <source dir> --outdir <output dir> --target bun --banner '#!/usr/bin/env bun'`
- `biome check <source dir>`
- `tsc --noEmit`

## Path model

| Path | Nature | Persistence |
|---|---|---|
| `/home/adda/`, `/tmp` | ephemeral tmpfs | wiped at container stop |
| `/usr/local/**` | immutable (read-only rootfs) | write attempts fail |
| `/workspace` | cloned repo (git-backed) | wiped — **commit and push to persist** |

`~/.claude/` is bootstrapped from the image at startup; editing it does not
affect future containers.

## Artifact routing

Edit repo source only — never runtime copies. Changes affect future image builds,
not the running container.

| Artifact | Repo source | Image-baked path | Bootstrapped to |
|---|---|---|---|
| Tier 1 entrypoint | `adda-dev-runtime/content/scripts/bootstrap/entrypoint.sh.source` | `/usr/local/libexec/adda-dev-runtime/bootstrap/entrypoint.sh` | — |
| Tier 1 interactive shell helper | `adda-dev-runtime/content/scripts/bootstrap/open-interactive-shell.sh.source` | `/usr/local/libexec/adda-dev-runtime/bootstrap/open-interactive-shell.sh` | — |
| `resolve-issue-branch` (Bun executable) | `adda-dev-runtime/src/runtime/resolve-issue-branch.ts` | `/usr/local/libexec/adda-dev-runtime/bin/resolve-issue-branch` | — |
| `ci-watch` (Bun executable) | `adda-dev-runtime/src/runtime/ci-watch.ts` | `/usr/local/libexec/adda-dev-runtime/bin/ci-watch` | — |
| `quality-gates` (Bun executable) | `adda-dev-runtime/src/runtime/quality-gates.ts` | `/usr/local/libexec/adda-dev-runtime/bin/quality-gates` | — |
| Tier 2 bootstrap hook | `proto-adda/content/scripts/bootstrap/entrypoint.d/10-claude-config.sh.source` | `/usr/local/libexec/adda-dev-runtime/bootstrap/entrypoint.d/10-claude-config.sh` | — |
| Claude config (CLAUDE.md, settings.json, agents/, skills/) | `proto-adda/content/.claude/` | `/usr/local/share/adda-dev-runtime/.claude/` | `~/.claude/` (ephemeral) |
| `prune-node-modules.sh` (build script) | `adda-dev-runtime/build/prune-node-modules.sh` | (build-stage only, not in final image) | — |

Scripts baked to `/usr/local/libexec/` use a `.sh.source` extension in the repo
and carry no exec bit; the Dockerfile `RUN chmod` sets the exec bit at build time.

## CI/build pipeline

`base.yml` builds Tier 1, then Tier 2 `FROM` Tier 1. Lints: shellcheck on shell scripts; hadolint on both Dockerfiles. Changes reach production: PR → CI →
edge image on main merge → versioned release on tag.

## Conventions

Script and Dockerfile conventions: `docs/conventions.md`.
