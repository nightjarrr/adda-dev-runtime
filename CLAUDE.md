# ADDA Dev Runtime

This repo *is* the dev runtime. Design and current state are in
`docs/adda-dev-runtime.md` and `docs/adda-dev-runtime-current-state.md`.

## Repo layout

- `adda-dev-runtime/` — Tier 1 base image (Dockerfile, content/scripts/).
- `proto-adda/` — Tier 2 AI-harness image. Ships content that the Tier 1
  entrypoint uses to initialize `~/.claude/` at container start.
- `launcher/adda-dev.sh` — host-side launcher.
- `docker/envoy/` — Envoy proxy template.

## Working on the runtime from inside the runtime

The Claude Code session that develops this repo runs in a proto-adda
container built from this same repo. Two consequences:

- **No Docker in the container.** Image builds and launch tests are run by
  PO on the host, not by the agent. Verification inside the container is
  limited to file/path checks and `quality-gates.sh`.
- **`/workspace` is the only durable path.** See *Path model* below.

## Tier architecture

**Tier 1** (`adda-dev-runtime/`) — generic, AI-tool-agnostic base. Ships
`entrypoint.sh`, `resolve-issue-branch.sh`, `ci-watch.sh`, `quality-gates.sh`,
system tools (git, gh, socat, rg, fdfind, etc.), and an empty
`entrypoint.d/` hook directory.

**Tier 2** (`proto-adda/`) — AI harness. Builds `FROM` Tier 1. Ships Node.js,
Claude Code, the Claude config, and the `10-claude-config.sh` bootstrap hook.

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
| Tier 1 entrypoint | `adda-dev-runtime/content/scripts/entrypoint.sh.source` | `/usr/local/libexec/adda-dev-runtime/entrypoint.sh` | — |
| `resolve-issue-branch.sh` | `adda-dev-runtime/content/scripts/resolve-issue-branch.sh.source` | `/usr/local/libexec/adda-dev-runtime/resolve-issue-branch.sh` | — |
| `ci-watch.sh` | `adda-dev-runtime/content/scripts/ci-watch.sh.source` | `/usr/local/libexec/adda-dev-runtime/ci-watch.sh` | — |
| `quality-gates.sh` | `adda-dev-runtime/content/scripts/quality-gates.sh.source` | `/usr/local/libexec/adda-dev-runtime/quality-gates.sh` | — |
| Tier 2 bootstrap hook | `proto-adda/content/entrypoint.d/10-claude-config.sh.source` | `/usr/local/libexec/adda-dev-runtime/entrypoint.d/10-claude-config.sh` | — |
| Claude config (CLAUDE.md, settings.json, agents/, skills/) | `proto-adda/content/.claude/` | `/usr/local/share/adda-dev-runtime/.claude/` | `~/.claude/` (ephemeral) |

Scripts baked to `/usr/local/libexec/` use a `.sh.source` extension in the repo
and carry no exec bit; the Dockerfile `RUN chmod` sets the exec bit at build time.

## CI/build pipeline

`base.yml` builds Tier 1, then Tier 2 `FROM` Tier 1. Lints: shellcheck on all
six scripts; hadolint on both Dockerfiles. Changes reach production: PR → CI →
edge image on main merge → versioned release on tag.

## Conventions

Script and Dockerfile conventions: `docs/conventions.md`.
