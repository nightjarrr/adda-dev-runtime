# proto-adda — Implementation Specifics

proto-adda is the Claude Code–based Tier 2 implementation of the ADDA SDLC. It builds `FROM` the Tier 1 `adda-dev-runtime` image and adds the Claude Code AI harness, the SDLC agent configuration, and a bootstrap hook that initialises the Claude environment at container start.

**"Proto"** reflects a deliberate simplification: the Associate Architect role defined in the [ADDA SDLC design](https://github.com/nightjarrr/molim/blob/main/docs/adda-sdlc.md) is collapsed into the Project Manager. The PM handles all creative and decision-heavy work directly — spec drafting, technical design, implementation planning, documentation updates — rather than delegating to a separate AA subagent. This covers the core development workflow but is not a complete implementation of all ADDA roles.

Companion to [`docs/adda-dev-runtime.md`](adda-dev-runtime.md), which covers the tier architecture, Tier 1 design, and shared build conventions.

---

## SDLC implementation

### Role mapping

| ADDA role | Proto-adda implementation |
|---|---|
| Project Owner | Human — unchanged |
| Project Manager | Main Claude Code session |
| Associate Architect | Collapsed into PM (proto simplification) |
| Coder | `coder` subagent |

The PM role is implemented as the primary Claude Code session. It owns the full SDLC workflow: reads Issue and repository state, runs or delegates each phase, manages all GitHub state updates, and surfaces gates to the Project Owner. Because AA is collapsed into PM, PM performs all artefact authoring work (specs, technical designs, implementation plans, documentation) directly in the main session rather than delegating.

The Coder role is implemented as a dispatched subagent. It is the only role with shell execution capability and is responsible for code changes, test coverage, and quality gates.

A secondary subagent, `ci-monitor`, handles CI workflow monitoring. It is dispatched by the `ci-gate` skill and is not a role defined in the ADDA SDLC design — it is proto-adda infrastructure.

### Skills

**SDLC-mapped skills** — implement operations defined in the ADDA SDLC skill catalog:

| Skill | ADDA SDLC counterpart |
|---|---|
| `new-issue` | New Issue |
| `ensure-github-labels` | Ensure GitHub Labels |

**Proto-adda-specific skills** — runtime infrastructure not in the SDLC design:

| Skill | Purpose |
|---|---|
| `go` | Issue workflow entry point — resolves issue state and starts the SDLC session |
| `ci-gate` | CI monitoring coordination — dispatches `ci-monitor` and interprets results |
| `adda-shell-tools` | Shell tool awareness — see *Shell tool awareness* below |

Additional auxiliary skills may be added over time and are not exhaustively listed here.

The `quality-gates` executable (Tier 1) implements the ADDA SDLC Quality Gates skill and is invoked by the Coder subagent.

### Agent permissions

The PM session operates under a least-privilege permission profile defined in `settings.json`. PM has read/write access to git and GitHub operations, invocation rights for SDLC-relevant skills, and explicit deny rules for destructive operations (force push, PR merge, secret access, release creation). PM has no direct shell execution — all shell operations flow through the Coder subagent.

---

## Bootstrap hook

The `10-claude-config.sh` hook is sourced by the Tier 1 entrypoint after core bootstrap (GitHub auth, clone, branch resolution) completes. It prepares the Claude environment so the harness is ready when CMD executes.

### Validation

The hook validates the presence of the `claude` binary and a set of required environment variables. Two backends are supported with different authentication requirements:

**`anthropic` backend** — direct Anthropic API access:
- `CLAUDE_CODE_OAUTH_TOKEN` — Claude Code OAuth token

**`deepseek` backend** — OpenAI-compatible proxy routing:
- `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` — proxy endpoint and auth
- `ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_OPUS_MODEL`, `ANTHROPIC_DEFAULT_SONNET_MODEL`, `ANTHROPIC_DEFAULT_HAIKU_MODEL` — model routing
- `CLAUDE_CODE_SUBAGENT_MODEL`, `CLAUDE_CODE_EFFORT_LEVEL` — subagent and effort configuration

Both backends also require `ADDA_DEV_LLM_BACKEND`, `CLAUDE_CODE_VERSION`, and `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`.

### Initialisation

The hook performs the following in order:

1. **Claude config deployment** — copies the staged config from `/usr/local/share/adda-dev-runtime/.claude/` to `~/.claude/`. Fails if `~/.claude/` already exists and is non-empty (guards against double-initialisation).

2. **Shell tool list** — writes `~/.claude/shell-tools.jsonl` from the tool registry accumulated by Tier 1 and any earlier hooks. This file is the input for the `adda-shell-tools` skill — see *Shell tool awareness* below.

3. **`~/.claude.json` generation** — renders the template at `/usr/local/share/adda-dev-runtime/templates/.claude.json.template` with `CLAUDE_CODE_VERSION` substituted. The resulting file pre-accepts Claude Code onboarding and grants workspace trust to `/workspace`, so the session starts without interactive prompts.

4. **Memory directory** — creates `/workspace/.claude/memory/` for the PM agent's persistent auto-memory. This path is inside the repository so memory survives container restarts through git.

5. **Git identity** — configures global git identity as `Claude Code (authorized by ${GH_USERNAME})` with email `${GH_USER_ID}+${GH_USERNAME}@users.noreply.github.com`. Commits are attributed to the Claude Code process but the noreply email is keyed to the human's GitHub user ID, so the avatar routes to the human's profile in the GitHub UI.

---

## Shell tool awareness

The `adda-shell-tools` skill gives the PM agent a live, accurate picture of which tools are available in the container — without probing with `which` or making assumptions about what is installed.

The mechanism spans three components:

1. **Tier 1 tool registry** — the Tier 1 entrypoint and any earlier `entrypoint.d/` hooks accumulate tool announcements via the `announce_shell_tool` helper. This builds a JSONL registry in memory during bootstrap.

2. **Persistence** — the bootstrap hook writes the accumulated registry to `~/.claude/shell-tools.jsonl` (step 2 of initialisation above).

3. **Rendering** — the `render-adda-shell-tools` executable reads `shell-tools.jsonl` and produces a formatted markdown table, including warnings about scripting runtimes that are absent (with Bun alternatives) and tools that are present but non-functional under container security policy. The `adda-shell-tools` skill invokes this executable and returns its output.

---

## Artifact mapping

Source paths in the repo map to image destinations by the convention described in `docs/adda-dev-runtime.md`. Proto-adda artifacts:

| Repo source | Image destination |
|---|---|
| `proto-adda/content/scripts/bootstrap/entrypoint.d/10-claude-config.sh.source` | `/usr/local/libexec/adda-dev-runtime/bootstrap/entrypoint.d/10-claude-config.sh` |
| `proto-adda/content/.claude/` | `/usr/local/share/adda-dev-runtime/.claude/` |
| `proto-adda/content/templates/.claude.json.template` | `/usr/local/share/adda-dev-runtime/templates/.claude.json.template` |
| `proto-adda/src/runtime/render-adda-shell-tools.ts` | `/usr/local/libexec/adda-dev-runtime/bin/render-adda-shell-tools` |

Shell scripts (`.sh.source`) are renamed and made executable by the Dockerfile at build time. TypeScript sources are compiled to extensionless Bun executables in a multi-stage build; only the compiled output ships in the final image.

---

## Image

**Name:** `ghcr.io/nightjarrr/proto-adda-dev-runtime`

**Base:** `FROM ghcr.io/nightjarrr/adda-dev-runtime` (Tier 1)

**CMD:** `["claude"]` — overrides Tier 1's default `/bin/bash`, making the Claude Code process the primary session process. If Claude Code exits, the Tier 1 entrypoint drops to an interactive bash shell for inspection.

**Claude Code version** is pinned via `ENV CLAUDE_CODE_VERSION` in the Dockerfile. The same value is used during the build (to install the correct package version) and at runtime (injected into `~/.claude.json` by the bootstrap hook). Version bumps go through an explicit chore Issue.

Tags and distribution follow the same conventions as Tier 1 — `edge`, `latest`, `v{X.Y.Z}`, `{sha}`, `ci` — documented in the *Image build and distribution* section of `docs/adda-dev-runtime.md`.
