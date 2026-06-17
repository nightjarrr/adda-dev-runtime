# ADDA Project Onboarding Guide

A checklist for setting up a new GitHub repository as an ADDA project. Designed to be followed by a human Project Owner working with an ADDA agent team.

**Companion documents:**
- [Conceptual design](adda-dev-runtime-design.md) — tier architecture, design principles, threat model
- [Technical design](adda-dev-runtime-technical-design.md) — Tier 3 infrastructure spec (init hook, quality gates, repository layout)
- [ADDA SDLC master doc](https://github.com/nightjarrr/molim/blob/main/docs/adda-sdlc.md) — vendor-agnostic SDLC design

---

## Prerequisites

A machine running the ADDA Dev Runtime launcher (see [host system setup guide](host-system-setup.md) for host preparation). A GitHub account with a scoped token for the new repository.

---

## GitHub repo setup

Configure the repository before any code is pushed.

- [ ] **Branch ruleset** — create a ruleset targeting the default branch (`main`) with:
  - Pull request required
  - Required approving reviews: 1
  - Dismiss stale reviews on push: off
  - Require review thread resolution: on
  - Required status checks (added after CI is wired up — see CI/CD section)
  - Non-fast-forward updates
  - Deletion prevention
- [ ] **Merge settings** — all three merge methods may remain enabled (merge commit, squash, rebase). Delete branch on merge recommended.
- [ ] **Wiki** — disable unless needed. Issues and `docs/` serve the documentation role.
- [ ] **Discussions** — disable unless needed.
- [ ] **Allow auto-merge** — disable; merge is a manual PO action.
- [ ] **Allow update branch** — enable; lets PR branches track `main` as it advances.

---

## Repository scaffolding

Standard files every project should carry.

- [ ] **README** — project name, purpose, quick-start, pointer to SDLC workflow.
- [ ] **LICENSE** — MIT, Apache 2.0, or project-appropriate license.
- [ ] **CONTRIBUTING** — how to open issues, submit PRs, and engage with the project.
- [ ] **SECURITY** — how to report vulnerabilities.
- [ ] **CODE_OF_CONDUCT** — community guidelines.
- [ ] **Issue templates** — `.github/ISSUE_TEMPLATE/` — at minimum a bug report and a feature request template.
- [ ] **PR template** — `.github/pull_request_template.md` — reminder checklist for the PR author.
- [ ] **`.gitignore`** — per-project language and tooling exclusions.
- [ ] **Pre-commit hooks** — optional but recommended. Can run quality gates locally before each commit. Use a hook config (e.g. `.pre-commit-config.yaml`) that mirrors the quality gates.

---

## ADDA compliance (Tier 3)

ADDA-specific files that a project needs to participate in the SDLC.

- [ ] **`CLAUDE.md`** — project-specific agent context: repo layout, conventions, toolchain. See technical design for the file structure.
- [ ] **`.adda-init.sh`** — repo-level init hook, if project dependencies must be installed. See technical design (Tier 3 → Init hook) for the spec.
- [ ] **`.quality-gates.toml`** — quality gate definitions. See technical design (Tier 3 → Repository layout) for the file name and structure. See Quality Gates Reference below for configuration guidance.
- [ ] **`docs/architecture.md`** — project architecture reference for agents.
- [ ] **`docs/conventions.md`** — coding and naming conventions.
- [ ] **SDLC labels** — bootstrap the standard label set by running the `ensure-github-labels` tool.
- [ ] **Dockerfile** — optional. Only needed when the project requires OS-level tooling not in Tier 1.
- [ ] **`CHANGELOG.md`** — running changelog with an `UPCOMING` section.

---

## CI/CD workflows

GitHub Actions required for the SDLC to operate.

- [ ] **CI workflow** — runs on push to any branch and on PR. Runs quality gates (tests, typecheck, lint, format) and any build step. Required checks from this workflow are wired into the branch ruleset.
- [ ] **Release workflow** — fires on `v*` tag pushes. Publishes artifacts, creates a GitHub release. Only needed if the project produces distributable artifacts.
- [ ] **Dependabot** — enable for dependency updates. Configure version update schedule and reviewers.

---

## Quality gates reference

The `.quality-gates.toml` file lists commands that must pass before code is committed or pushed. Each non-comment line is a command; a zero exit status means PASS.

- **Ordering:** auto-fixers before verifiers, so verifiers run on already-fixed code (e.g. `ruff check --fix .` before `ruff check .`).
- **Tool variant choice:** auto-fixing variants (e.g. `--fix`, `--format` in place) are preferred when available — they reduce friction. The verifier after them catches what the fixer missed.
- **What PASS means:** a command that auto-fixes and exits 0 counts as PASS. Files may have been modified even on a green run.
- **Non-interactive:** all commands must be fully automated — no prompts or stdin input.
- **Existing project start:** if starting from an existing codebase, run auto-fixers once and commit the result before wiring up quality gates as a hard requirement.

---

## To be reviewed

These items are considered relevant to a well-configured ADDA project but need further discussion before becoming firm recommendations.

- **Branch naming rules** — enforce ADDA branch naming (`type/issue-id-slug`) via the ruleset. Ensures consistency but adds friction for non-standard branch names.
- **Merge message format** — squash merge defaults (PR title + all commits) vs. a more curated format. Affects `git log` readability.
- **Tag protection** — prevents accidental deletion or forced update of release tags. Relevant for the release workflow.
- **Squash merge restriction** — limiting to squash-only reduces history complexity but loses individual commit structure from feature branches.
- **Repository topics / description** — discoverability via GitHub search.
- **Security settings** — private vulnerability reporting, Dependabot alerts, secret scanning. Depends on repo visibility and GitHub plan.
- **Copilot code review** — automated AI review on PRs. Useful but adds noise on small changes.
