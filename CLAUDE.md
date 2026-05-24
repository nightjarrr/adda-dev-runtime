# ADDA Dev Runtime

This repo *is* the dev runtime. Design and current state are in
`docs/adda-dev-runtime.md` and `docs/adda-dev-runtime-current-state.md`.

## Repo layout

- `docker/adda-dev-runtime/` — Tier 1 base image (Dockerfile, entrypoint.sh).
- `proto-adda/` — Tier 2 AI-harness image. Ships an overlay
  (`proto-adda/overlay/`) that the Tier 1 entrypoint applies to `~/.claude/`
  at container start.
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

**Tier 1** (`docker/adda-dev-runtime/`) — generic, AI-tool-agnostic base. Ships
`entrypoint.sh`, system tools (git, gh, socat, rg, fdfind, etc.), and an empty
`entrypoint.d/` hook directory.

**Tier 2** (`proto-adda/`) — AI harness. Builds `FROM` Tier 1. Ships Node.js,
Claude Code, Tier 2-owned scripts, the Claude config overlay, and the
`10-claude-config.sh` bootstrap hook.

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
| Tier 1 entrypoint | `docker/adda-dev-runtime/entrypoint.sh` | `/usr/local/libexec/adda-dev-runtime/entrypoint.sh` | — |
| Tier 2 bootstrap hook | `proto-adda/overlay/entrypoint.d/10-claude-config.sh` | `/usr/local/libexec/adda-dev-runtime/entrypoint.d/10-claude-config.sh` | — |
| `quality-gates.sh` | `proto-adda/overlay/scripts/quality-gates.sh.source` | `/usr/local/libexec/adda-dev-runtime/quality-gates.sh` | — |
| `ci-watch.sh` | `proto-adda/overlay/scripts/ci-watch.sh.source` | `/usr/local/libexec/adda-dev-runtime/ci-watch.sh` | — |
| `resolve-issue-branch.sh` | `proto-adda/overlay/scripts/resolve-issue-branch.sh.source` | `/usr/local/libexec/adda-dev-runtime/resolve-issue-branch.sh` | — |
| Claude overlay (CLAUDE.md, settings.json, agents/, skills/) | `proto-adda/overlay/.claude/` | `/usr/local/share/adda-dev-runtime/.claude/` | `~/.claude/` (ephemeral) |

Scripts under `proto-adda/overlay/scripts/` use a `.sh.source` extension in the
repo; the Dockerfile strips `.source` on COPY. `resolve-issue-branch.sh` is
Tier 2-owned but called by Tier 1 `entrypoint.sh` — known issue #94.

## CI/build pipeline

`base.yml` builds Tier 1, then Tier 2 `FROM` Tier 1. Lints: shellcheck on
`entrypoint.sh`, `launcher/adda-dev.sh`, `10-claude-config.sh`; hadolint on both
Dockerfiles. Changes reach production: PR → CI → edge image on main merge →
versioned release on tag.

## Conventions

Script and Dockerfile conventions: `docs/conventions.md`.
