# ADDA Project Onboarding Guide

A checklist for setting up a new GitHub repository as an ADDA project. Designed to be followed by a human Project Owner working with an ADDA agent team.

**Companion documents:**
- [ADDA SDLC master doc](https://github.com/nightjarrr/molim/blob/main/docs/adda-sdlc.md) — the vendor-agnostic Agentic SDLC design that this guide supports
- [ADDA Dev Runtime — conceptual design](adda-dev-runtime-design.md) — the runtime's architecture (Tier 1/2/3), design principles, and threat model. The "project" in this guide is a Tier 3 repository in that model
- [ADDA Dev Runtime — technical design](adda-dev-runtime-technical-design.md) — implementation details for Tier 3 compliance (init hook, quality gates, repository layout)

---

## Prerequisites

A GitHub repository (public or private — no practical difference for ADDA features) owned by a GitHub account with admin access, with Issues enabled. A machine running the ADDA Dev Runtime launcher (see [host system setup guide](host-system-setup.md) for host preparation). A GitHub token scoped to the repository.

---

## GitHub repo setup

Configure the repository after creation, before the first agent-driven commit reaches it.

- [ ] **Default branch** — set to `main`. This name is referenced throughout ADDA documentation and tooling.
- [ ] **Branch ruleset** — create a ruleset targeting the default branch (`main`) with:
  - Pull request required
  - Required approving reviews: 1
  - Dismiss stale reviews on push: off
  - Require review thread resolution: on
  - Required status checks (added after CI is wired up — see CI/CD section)
  - Non-fast-forward updates — prevents force pushes; the branch is only advanceable by adding commits
  - Deletion prevention
- [ ] **Branch naming ruleset** — optional but recommended. A separate ruleset for non-`main` branches enforcing `{type}/{issue-id}-{slug}` (where type is one of `feature`, `chore`, `docs`, `bug`). Exclusion patterns can be added to allow integrations (e.g. Dependabot) or other non-ADDA workflows.
- [ ] **Merge settings** — all three merge methods may remain enabled, but set **squash** as the default. Most PRs should be squash-merged; merge commit or rebase are exceptions for specific cases. Commit message format:

  | Method | Title | Body |
  |---|---|---|
  | Merge commit | MERGE_MESSAGE (default "Merge pull request #N") | PR_TITLE |
  | Squash | PR_TITLE | COMMIT_MESSAGES (all commits from the branch) |

  Delete branch on merge recommended.
- [ ] **Wiki** — disable unless needed. Issues and `docs/` serve the documentation role.
- [ ] **Discussions** — disable unless needed.
- [ ] **Allow auto-merge** — disable; merge is a manual PO action.
- [ ] **Allow update branch** — enable. Lets the agent keep PR branches up to date with `main` as it advances without manual rebase.
- [ ] **Description and topics** — set a concise repository description and relevant topics for discoverability.
- [ ] **Private vulnerability reporting** — enable to receive notifications about security issues.
- [ ] **Dependabot alerts** — enable to receive notifications about vulnerable dependencies.
- [ ] **Secret scanning (GitHub toggle)** — enable in repository settings for automatic detection of known credential patterns.
- [ ] **Tag protection** — create a tag protection rule for release tags (e.g. `v*`) to prevent accidental deletion or forced update.

---

## Repository scaffolding

Standard files every project should carry.

- [ ] **README** — project name, purpose, quick-start, pointer to SDLC workflow. Include badges for CI status, latest release version, and any relevant project metadata.
- [ ] **LICENSE** — MIT, Apache 2.0, or project-appropriate license.
- [ ] **CONTRIBUTING** — how to open issues, submit PRs, and engage with the project.
- [ ] **SECURITY** — how to report vulnerabilities.
- [ ] **CODE_OF_CONDUCT** — community guidelines.
- [ ] **Issue templates** — `.github/ISSUE_TEMPLATE/` — at minimum a bug report and a feature request template.
- [ ] **PR template** — `.github/pull_request_template.md` — reminder checklist for human contributors. ADDA agents generate PR bodies programmatically and do not use the template.
- [ ] **`.gitignore`** — per-project language and tooling exclusions.
- [ ] **Pre-commit hooks** — must be configured per project toolset. Invokes the `quality-gates` script locally before each commit, providing rapid feedback before CI. Use a hook config (e.g. `.pre-commit-config.yaml`) that runs `quality-gates`.

---

## ADDA compliance (Tier 3)

ADDA-specific files that a project needs to participate in the SDLC.

- [ ] **Agent context file** — project-specific orientation for the AI agent: repo layout, conventions, toolchain. The file name depends on the Tier 2 implementation (e.g. `CLAUDE.md` for proto-adda). See technical design (Tier 3 → Repository layout) for the expected location and structure.
- [ ] **`.adda-init.sh`** — repo-level init hook, if project dependencies must be installed. See technical design (Tier 3 → Init hook) for the spec.
- [ ] **`.quality-gates.toml`** — quality gate definitions. Required — without it, quality gates error and fail. See technical design (Tier 3 → Repository layout) for the file name and structure. See Quality Gates Reference below for configuration guidance.
- [ ] **`docs/architecture.md`** — project architecture reference for agents.
- [ ] **`docs/conventions.md`** — coding and naming conventions.
- [ ] **SDLC labels** — bootstrap the standard label set by running the `ensure-github-labels` skill (available in proto-adda and other Tier 2 implementations).
- [ ] **Dockerfile** — optional. Only needed when the project requires OS-level tooling not present in Tier 1 or Tier 2. See Optional Dockerfile section in the technical design for details.

---

## CI/CD workflows

GitHub Actions required for the SDLC to operate.

- [ ] **CI workflow** — runs on push to any branch and on PR. Runs the same commands defined in `.quality-gates.toml` (tests, typecheck, lint, format) plus a secret scanning step (e.g. Gitleaks) and any project-specific build step. Required checks from this workflow are wired into the branch ruleset.
- [ ] **Release workflow** — fires on `v*` tag pushes. Publishes artifacts, creates a GitHub release. Only needed if the project produces distributable artifacts.
- [ ] **Dependabot** — enable for dependency updates. Configure version update schedule and reviewers.

---

## Quality gates reference

The `.quality-gates.toml` file lists commands that must pass before code is committed or pushed. Each non-comment line is a command; a zero exit status means PASS.

- **Required:** the file must exist and be non-empty for quality gates to be enforced. An absent file causes quality gates to error and fail.
- **Ordering:** auto-fixers before verifiers, so verifiers run on already-fixed code (e.g. `ruff check --fix .` before `ruff check .`).
- **Tool variant choice:** auto-fixing variants (e.g. `--fix`, `--format` in place) are preferred when available — they reduce friction. The verifier after them catches what the fixer missed.
- **What PASS means:** a command that auto-fixes and exits 0 counts as PASS. Files may have been modified even on a green run.
- **Non-interactive:** all commands must be fully automated — no prompts or stdin input.
- **Existing project start:** if starting from an existing codebase, run auto-fixers once and commit the result before wiring up quality gates as a hard requirement.

