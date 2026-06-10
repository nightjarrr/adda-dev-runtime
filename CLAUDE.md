# ADDA Dev Runtime

This repo *is* the dev runtime. Conceptual design is documented in `docs/adda-dev-runtime-design.md`; technical design (entrypoint sequence, configuration, artifact routing) is in `docs/adda-dev-runtime-technical-design.md`.

## Repo layout

- `adda-dev-runtime/` — Tier 1 base image (Dockerfile, content/scripts/).
- `proto-adda/` — Tier 2 AI-harness image. Adds Claude Code, the Claude
  config, and the `10-claude-config.sh` bootstrap hook.
- `launcher/` — host-side launcher script, config, and Envoy proxy template.

## Working on the runtime from inside the runtime

The Claude Code session that develops this repo runs in a proto-adda
container built from this same repo. See `docs/self-hosting.md` for what
this means and the constraints it creates.

## Tier architecture

**Tier 1** (`adda-dev-runtime/`) — generic, AI-tool-agnostic base. Ships
container startup scripts under `/usr/local/libexec/adda-dev-runtime/bootstrap/`
(including `entrypoint.sh` and the `entrypoint.d/` hook directory), runtime tools
invokable by the agent under `/usr/local/libexec/adda-dev-runtime/bin/`, system
tools (git, gh, socat, rg, fdfind, etc.), and Bun — making TypeScript a
first-class scripting language for Tier 1 scripts; see
`docs/bun-scripting-for-adda.md`. Note: `@types/bun`, `oxlint`, `oxfmt`, and
`typescript` are **not** image globals — they are repo `devDependencies` in
`package.json`, installed by `.adda-init.sh`; invoke them via `bun run <tool>`.

**Tier 2** (`proto-adda/`) — AI harness. Builds `FROM` Tier 1. Ships Claude
Code, the Claude config, and the `10-claude-config.sh` bootstrap hook.

## Repo-level init hook

`.adda-init.sh` in the repo root is invoked as a subprocess by the entrypoint at
bootstrap and by `current-issue switch` mid-session after a branch checkout.

**What it does in this repo:**

- Reads `@types/bun` version from `package.json` and compares it to `$BUN_VERSION`
  (the version baked into the image).
- **Match:** runs `bun install --frozen-lockfile`.
- **Mismatch:** runs `bun add --dev "@types/bun@${BUN_VERSION}"` to auto-correct,
  then writes `/workspace/CLAUDE.local.md` with exact versions and a
  ready-to-paste commit message.

**Lockfile:** `bun.lock` (text format, Bun 1.3.14 default) is committed to the
repo. The `--frozen-lockfile` flag keeps it authoritative on the happy path.

**Branch init signal:** if `package.json` and/or `bun.lock` are dirty after a
branch switch or at bootstrap with an `@types/bun` version change, the init hook
auto-corrected a version mismatch. Check `CLAUDE.local.md` for details and the
commit command.

## Script placement decision model

When adding a new script, use these four axes to determine where it goes:

0. **Host vs Container**: if the script runs on the host, it lives in `launcher/`
   and this decision model does not apply. If it runs inside the container,
   proceed to axes 1–3.

1. **Tier**: Tier 1 (`adda-dev-runtime/`) if generic and AI-tool-agnostic, or if
   the script modifies the bootstrap/entrypoint process itself (rather than
   extending it via a hook or other extensibility point); Tier 2 (`proto-adda/`)
   if harness-specific.

2. **bootstrap vs bin vs build**: `bootstrap/` if the script runs during container startup
   (entrypoint, hook, interactive-shell helper) and must **not** be agent-invokable;
   `bin/` if the script is invokable by the agent at runtime;
   `adda-dev-runtime/build/` if the script runs only during Docker image *build* (e.g.,
   post-processing build artifacts) and must **not** be present in any image.

3. **Shell vs Bun**: shell (`.sh.source`) if it is simple glue, needs to source the
   environment, or is part of the hook chain; Bun (`.ts`) if it needs structured
   argument parsing, typed logic, external API calls, or testability.

## Toolchain

Bun is a pre-installed global. `oxlint`, `oxfmt`, and `tsc` are repo
`devDependencies` installed by `.adda-init.sh`; invoke them via `bun run <tool>`.

Correct invocations:

- `bun test --coverage --coverage-reporter=lcov --coverage-reporter=text --coverage-dir=<output dir>`
- `bun build <source dir> --outdir <output dir> --target bun --banner '#!/usr/bin/env bun'`
- `bun run oxlint <src>`
- `bun run oxfmt --check <src>` (check only) / `bun run oxfmt <src>` (format in place)
- `bun run tsc --noEmit`

## Artifact routing

Edit repo source only — never runtime copies. Changes affect future image builds,
not the running container.

Source paths map to image destinations by a consistent convention. `<libexec>`
expands to `/usr/local/libexec/adda-dev-runtime`:

```
Source                                                                         Destination
──────────────────────────────────────────────────────────────────────────────────────────────────────
Tier 1 (adda-dev-runtime)
  adda-dev-runtime/content/scripts/bootstrap/entrypoint.sh.source             <libexec>/bootstrap/entrypoint.sh
  adda-dev-runtime/src/runtime/<name>.ts                                       <libexec>/bin/<name>
  adda-dev-runtime/src/bootstrap/<name>.ts                                     <libexec>/bootstrap/<name>
  adda-dev-runtime/content/scripts/runtime/<name>.sh.source                    <libexec>/bin/<name>.sh
  adda-dev-runtime/content/scripts/bootstrap/<name>.sh.source                  <libexec>/bootstrap/<name>.sh
  adda-dev-runtime/content/scripts/bootstrap/entrypoint.d/<h>.sh.source        <libexec>/bootstrap/entrypoint.d/<h>.sh

Tier 2 (proto-adda)
  proto-adda/src/runtime/<name>.ts                                              <libexec>/bin/<name>
  proto-adda/src/bootstrap/<name>.ts                                            <libexec>/bootstrap/<name>
  proto-adda/content/scripts/runtime/<name>.sh.source                           <libexec>/bin/<name>.sh
  proto-adda/content/scripts/bootstrap/<name>.sh.source                         <libexec>/bootstrap/<name>.sh
  proto-adda/content/scripts/bootstrap/entrypoint.d/<h>.sh.source               <libexec>/bootstrap/entrypoint.d/<h>.sh
```

Shell scripts (`.sh.source`) carry no exec bit in the repo; the Dockerfile renames
them (strips `.source`) and sets the exec bit. Bun executables are compiled from
`.ts` source in a multi-stage build.

Current artifacts:

| Artifact | Repo source | Image-baked path | Bootstrapped to |
|---|---|---|---|
| Tier 1 entrypoint | `adda-dev-runtime/content/scripts/bootstrap/entrypoint.sh.source` | `/usr/local/libexec/adda-dev-runtime/bootstrap/entrypoint.sh` | — |
| Tier 1 interactive shell helper | `adda-dev-runtime/content/scripts/bootstrap/open-interactive-shell.sh.source` | `/usr/local/libexec/adda-dev-runtime/bootstrap/open-interactive-shell.sh` | — |
| `resolve-issue-branch` (Bun executable) | `adda-dev-runtime/src/runtime/resolve-issue-branch.ts` | `/usr/local/libexec/adda-dev-runtime/bin/resolve-issue-branch` | — |
| `ci-watch` (Bun executable) | `adda-dev-runtime/src/runtime/ci-watch.ts` | `/usr/local/libexec/adda-dev-runtime/bin/ci-watch` | — |
| `quality-gates` (Bun executable) | `adda-dev-runtime/src/runtime/quality-gates.ts` | `/usr/local/libexec/adda-dev-runtime/bin/quality-gates` | — |
| Tier 1 gate hook | `adda-dev-runtime/content/scripts/bootstrap/entrypoint.d/95-write-shell-tools-registry.sh.source` | `/usr/local/libexec/adda-dev-runtime/bootstrap/entrypoint.d/95-write-shell-tools-registry.sh` | — |
| Tier 2 bootstrap hook | `proto-adda/content/scripts/bootstrap/entrypoint.d/10-claude-config.sh.source` | `/usr/local/libexec/adda-dev-runtime/bootstrap/entrypoint.d/10-claude-config.sh` | — |
| Tier 2 render hook | `proto-adda/content/scripts/bootstrap/entrypoint.d/96-render-shell-tools.sh.source` | `/usr/local/libexec/adda-dev-runtime/bootstrap/entrypoint.d/96-render-shell-tools.sh` | — |
| Claude config (CLAUDE.md, settings.json, agents/, skills/) | `proto-adda/content/.claude/` | `/usr/local/share/adda-dev-runtime/.claude/` | `~/.claude/` (ephemeral) |
| `render-adda-shell-tools` (Bun executable) | `proto-adda/src/runtime/render-adda-shell-tools.ts` | `/usr/local/libexec/adda-dev-runtime/bin/render-adda-shell-tools` | — |
| `prune-node-modules.sh` (build script) | `adda-dev-runtime/build/prune-node-modules.sh` | (build-stage only, not in final image) | — |
| `current-issue` (Bun executable) | `adda-dev-runtime/src/runtime/current-issue.ts` | `/usr/local/libexec/adda-dev-runtime/bin/current-issue` | — |
| Shell tools rendered markdown (runtime artifact) | produced by `96-render-shell-tools.sh` at bootstrap | `/run/adda/.adda-shell-tools.md` | — |

## CI/build pipeline

`base.yml` builds Tier 1, then Tier 2 `FROM` Tier 1. Lints: shellcheck on shell scripts; hadolint on both Dockerfiles. Changes reach production: PR → CI →
edge image on main merge → versioned release on tag.

## Conventions

Script and Dockerfile conventions: `docs/conventions.md`.
