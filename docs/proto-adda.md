# proto-adda — Implementation Specifics

proto-adda is the Claude Code–based Tier 2 implementation of the ADDA SDLC. It builds `FROM` the Tier 1 `adda-dev-runtime` image, installs Claude Code, and adds the SDLC agent configuration and a bootstrap hook that initialises the Claude environment at container start.

**"Proto"** reflects a deliberate, scoped simplification of the full ADDA SDLC design. The simplifications are intentional, not gaps to fill: proto-adda exists to provide a minimal viable workflow that is itself good enough to support agentic development of full ADDA implementations (DAWE and other future Tier 2s). Concretely: the Associate Architect role is collapsed into the Project Manager; the per-issue artifact structure (spec, tech design, implementation plan) is not produced; issue phases are simplified; and changelog handling is omitted. The core loop — triage, implement, review, merge — is covered.

Companion to [`docs/adda-dev-runtime-design.md`](adda-dev-runtime-design.md) (tier architecture) and [`docs/adda-dev-runtime-technical-design.md`](adda-dev-runtime-technical-design.md) (Tier 1 design and shared build conventions).

---

## Image

**Name:** `ghcr.io/nightjarrr/proto-adda-dev-runtime`

**Base:** `FROM ghcr.io/nightjarrr/adda-dev-runtime` (Tier 1)

**Claude Code** is installed as a version-pinned global Bun package. The version is set via `ENV CLAUDE_CODE_VERSION` in the Dockerfile — the same value drives the package install at build time and is injected into `~/.claude.json` by the bootstrap hook at runtime. Version bumps go through an explicit chore Issue.

**CMD:** `["claude"]` — overrides Tier 1's default `/bin/bash`, making the Claude Code process the primary session process. If Claude Code exits, the Tier 1 entrypoint drops to an interactive bash shell for inspection.

Tags and distribution follow the same conventions as Tier 1 — `edge`, `latest`, `v{X.Y.Z}`, `{sha}`, `ci` — documented in the *Image build and distribution* section of `docs/adda-dev-runtime-technical-design.md`.

---

## SDLC implementation

### Role mapping

| ADDA role | Proto-adda implementation |
|---|---|
| Project Owner | Human — unchanged |
| Project Manager | Main Claude Code session |
| Associate Architect | Collapsed into PM (proto simplification) |
| Coder | `coder` subagent |

The PM role is implemented as the primary Claude Code session. It owns the SDLC workflow: reads Issue and repository state, runs or delegates each phase, manages all GitHub state updates, and surfaces gates to the Project Owner. Because AA is collapsed into PM, PM performs all artefact authoring work directly in the main session rather than delegating.

The Coder role is implemented as a dispatched subagent, responsible for code changes, test coverage, and quality gates.

### Skills

Proto-adda implements two skills from the ADDA SDLC skill catalog: `new-issue` (New Issue) and `ensure-github-labels` (Ensure GitHub Labels). The `quality-gates` executable in Tier 1 implements the ADDA Quality Gates skill and is invoked by Coder.

In addition, proto-adda ships infrastructure skills that are not part of the SDLC design: `go` as the issue workflow entry point, `ci-gate` for CI monitoring coordination, and `adda-shell-tools` for shell tool awareness (see *Shell tool awareness* below). Further auxiliary skills may be added over time.

### Agent permissions

The PM session operates under a least-privilege permission profile. PM has pre-allowlisted shell access for specific toolsets (git, gh, bun, runtime executables) and explicit deny rules for destructive operations (force push, PR merge, secret access, release creation). Arbitrary shell execution is not permitted to PM — unbounded shell access is scoped to the Coder subagent.

---

## Bootstrap hook

The `10-claude-config.sh` hook is sourced by the Tier 1 entrypoint after core bootstrap (GitHub auth, clone, branch resolution) completes. It prepares the Claude environment so the harness is ready when CMD executes.

### Validation

The hook validates the presence of the `claude` binary and a set of required environment variables. Two backends are supported with different authentication requirements:

**`anthropic` backend** — direct Anthropic API access:
- `CLAUDE_CODE_OAUTH_TOKEN` — Claude Code OAuth token

**`deepseek` backend** — Anthropic API-compatible alternative backend:
- `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` — endpoint and auth
- `ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_OPUS_MODEL`, `ANTHROPIC_DEFAULT_SONNET_MODEL`, `ANTHROPIC_DEFAULT_HAIKU_MODEL` — model routing
- `CLAUDE_CODE_SUBAGENT_MODEL`, `CLAUDE_CODE_EFFORT_LEVEL` — subagent and effort configuration

Both backends also require `ADDA_DEV_LLM_BACKEND`, `CLAUDE_CODE_VERSION`, and `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`.

### Initialisation

The hook performs the following in order:

1. **Claude config deployment** — copies the staged config from `/usr/local/share/adda-dev-runtime/.claude/` to `~/.claude/`. Fails if `~/.claude/` already exists and is non-empty (guards against double-initialisation).

2. **`~/.claude.json` generation** — renders the template at `/usr/local/share/adda-dev-runtime/templates/.claude.json.template` with `CLAUDE_CODE_VERSION` substituted. The resulting file pre-accepts Claude Code onboarding and grants workspace trust to `/workspace`, so the session starts without interactive prompts.

3. **Memory directory** — creates `/workspace/.claude/memory/` for the PM agent's persistent auto-memory. This path is inside the repository so memory survives container restarts through git.

4. **Git identity** — configures global git identity as `Claude Code (authorized by ${GH_USERNAME})` with email `${GH_USER_ID}+${GH_USERNAME}@users.noreply.github.com`. Commits are attributed to the Claude Code process but the noreply email is keyed to the human's GitHub user ID, so the avatar routes to the human's profile in the GitHub UI.

---

## Shell tool awareness

The `adda-shell-tools` skill gives the PM agent a live, accurate picture of which tools are available in the container — without probing with `which` or making assumptions about what is installed.

The mechanism spans three components:

1. **Tier 1 tool registry** — the Tier 1 entrypoint and any earlier `entrypoint.d/` hooks accumulate tool announcements via the `announce_shell_tool` helper. This builds a JSONL registry in memory during bootstrap.

2. **Persistence** — the Tier 1 entrypoint writes the accumulated registry to `/run/.adda-shell-tools.jsonl` after all `entrypoint.d/` hooks complete.

3. **Rendering** — the `render-adda-shell-tools` executable reads `shell-tools.jsonl` and produces a formatted markdown table, including warnings about scripting runtimes that are absent (with Bun alternatives) and tools that are present but non-functional under container security policy. The `adda-shell-tools` skill invokes this executable and returns its output.

---

## Artifact mapping

Source paths in the repo map to image destinations by the convention described in the *libexec layout* section of `docs/adda-dev-runtime-technical-design.md`. Proto-adda artifacts:

| Repo source | Image destination |
|---|---|
| `proto-adda/content/scripts/bootstrap/entrypoint.d/10-claude-config.sh.source` | `/usr/local/libexec/adda-dev-runtime/bootstrap/entrypoint.d/10-claude-config.sh` |
| `proto-adda/content/.claude/` | `/usr/local/share/adda-dev-runtime/.claude/` |
| `proto-adda/content/templates/.claude.json.template` | `/usr/local/share/adda-dev-runtime/templates/.claude.json.template` |
| `proto-adda/src/runtime/render-adda-shell-tools.ts` | `/usr/local/libexec/adda-dev-runtime/bin/render-adda-shell-tools` |

Shell scripts (`.sh.source`) are renamed and made executable by the Dockerfile at build time. TypeScript sources are compiled to extensionless Bun executables in a multi-stage build; only the compiled output ships in the final image.
