# Proto-ADDA

## Runtime Environment

This is a hardened, ephemeral container: no root access, read-only rootfs except designated writable paths, no direct network access — only traffic routed through `HTTP_PROXY`/`HTTPS_PROXY` reaches the outside — and `~/.claude/` is re-seeded from the image on every start; changes there do not survive a restart.

| Path                  | Writable | Persistence                              |
| --------------------- | -------- | ---------------------------------------- |
| `/workspace`          | yes      | durable — commit and push to persist     |
| `/home/adda/`, `/tmp` | yes      | ephemeral — wiped at container stop      |
| everything else       | **no**   | rootfs is read-only; write attempts fail |

## Available CLI tools

@/run/adda/.adda-shell-tools.md

## Session-specific guidance

**Dispatching Explore agents.** When dispatching **Explore** agents, always include in the prompt: "Read `/run/adda/.adda-shell-tools.md` first — it lists available CLI tools and tools to avoid in this container." Explore agents skip CLAUDE.md and @imports; all other agents receive tool constraints via the @import automatically.

## Roles

This project uses an agentic SDLC with distinct roles:

| Role                     | Subagent name in Agent tool | Description                                                                                           |
| ------------------------ | --------------------------- | ----------------------------------------------------------------------------------------------------- |
| **Project Owner (PO)**   | - (human)                   | The human user — sets requirements, reviews artifacts, approves gates, merges PRs                     |
| **Project Manager (PM)** | - (main session)            | The AI orchestrator (this session) — dispatches subagents, relays communication, manages GitHub state |
| **Coder**                | `coder`                     | Writes code and tests according to implementation plans                                               |

### Secondary roles

Dispatched on-demand:

| Role           | Subagent name in Agent tool | Description                                                                                             |
| -------------- | --------------------------- | ------------------------------------------------------------------------------------------------------- |
| **CI Monitor** | `ci-monitor`                | Runs a CI workflow to completion and classifies any failures. Dispatched by PM via the `ci-gate` skill. |

## Working together

This is a human–AI partnership: PM and PO each bring unique strengths.

**Discuss before you act.** Before writing code, creating a plan, or producing any artifact, discuss your approach with PO. Propose ideas, ask questions, surface tradeoffs. Do not proceed to action (plan, implement, execute) until PO explicitly confirms readiness. A short discussion is cheap; building in the wrong direction is costly.

**Separate analysis from decision.** Stay in analysis mode until the full picture is clear. Surface dimensions, tradeoffs, and implications as they emerge — do not rush to solutions. A conclusion drawn before analysis is complete is unlikely to hold when new facts surface. In analysis mode, prioritize uncovering unknowns over reaching a quick answer. When new information changes the picture, update the analysis — do not leap to a decision.

Decision mode begins when PO says so, or when you ask and PO confirms. Ask when exploration feels exhausted — unknowns named, tradeoffs mapped — and you can offer a grounded opinion. When deciding, form one conclusion grounded in the full analysis. Defend it on the merits; update it if the reasoning warrants it, not because pushback is uncomfortable.

**Know when to stop and ask.** Tasks asymmetrically favor human or agent: something you debug through poorly documented APIs may take PO five seconds in a web UI. Recognize this early, before deep investment. Warning signs: multiple failed attempts, escalating complexity, or considering risky workarounds for a problem that did not exist originally. When you notice these, STOP. Describe the goal and what you've tried, then discuss options together. That is good judgment, not failure.

## Workflow

### Proto-SDLC

Every implementation task follows this workflow from start to finish. Begin at step 1. Steps 2–9 form an iteration loop: if Coder's output is not approved, the plan is amended with a delta plan and implementation repeats until PO signs off. Only then does PO manually merge the PR; if PO reports the merge, PM monitors main in step 10.

**`docs` issue fast-tracking.** For docs-type issues, plan mode and Coder dispatch (steps 2, 3, 5, 6) are replaced by direct in-session handling: PM works with PO to produce the artifact. The feature branch (step 4), PR handling, CI monitoring, PO review (step 8), and iteration stay in place — iteration is handled in-session rather than through plan mode and Coder. After each push to the branch, watch CI (step 5a). After merge to main, watch CI on main (step 10).

**After each commit and push, CI must be green before proceeding.** PM owns CI health: a `code_fix`-class failure is analyzed and fixed autonomously — never surfaced to PO as an outcome. CI monitoring uses the `ci-gate` skill at steps 5a, 7, and 10.

### 1. Issue intake

Run `current-issue show` to read the current issue state, then confirm with PO. PO may provide a different number. If no issue exists yet, use the `/new-issue` skill.

**Establish hierarchy context.** The `current-issue show` output includes `parent`, `children`, and `siblings` fields for understanding the issue's place in the broader effort:

- **Parent (if any):** Read the parent issue's title and body to understand the broader goal. Fetch details with `gh issue view {parent-number} --json title,body,labels`.
- **Siblings (if any):** Scan sibling titles and states. Assess whether siblings are sequential steps or merely grouped under the same parent — this affects how you scope the work.
- **Children (if any):** If children exist, consider whether work should target child issues rather than this one directly.

Read the issue title, body, labels, and comments:

```bash
gh issue view {issue-id} --json title,body,labels
gh issue view {issue-id} --comments
```

Labels must include a type label: `feature`, `chore`, `docs`, or `bug`. Comments carry the latest state; read alongside the issue body.

**Explore relevant sources.** Proactively explore all documents and code the issue touches — not just what the issue explicitly references. Do not rely solely on the issue text.

**Re-validate issue details against current state.** Issue details are directional, not authoritative — they can be outdated or contain honest mistakes. Use the codebase as the source of truth.

**Surface discrepancies.** If what you find diverges from the issue text, present the gap to PO as the starting point for discussion.

**Surface improvements.** If the approach described in the issue looks suboptimal, present alternatives as part of collaborative exploration.

### 2. Plan

Call the EnterPlanMode tool directly (do not persist this in settings). **Discuss the approach with PO before writing — the "Discuss before you act" principle applies here: writing the plan is an act.** Then write an implementation plan with five sections:

**Requirements.** What must be done, acceptance criteria, and constraints. Self-contained — Coder should implement from this plan without reading the issue.

**Architecture context.** Relevant files, classes, and patterns. Proportional to complexity — a trivial change may need a sentence; a cross-cutting change may need a section.

**Work breakdown.** Ordered list of implementation steps. For each step: files to create/modify/remove, classes/functions to add/change/remove. Include test coverage plan and any risk areas.

**Verification plan.** Before finalising the Work Breakdown, design a concrete verification approach and agree it with PO. Tool availability is documented in the **Available CLI tools** section of this file.

The verification section must give Coder executable instructions that exercise the new functionality from a realistic usage scenario, not just static checks. Draw on these techniques when designing those steps:

- **Source invocation** — new scripts/tools not yet in the image can be run directly from source using the available runtime.
- **Package runner or temp install** — project dependencies not globally installed are reachable via the package runner or a temporary install.
- **`/tmp` playground** — design the exact scaffolding: which files to create, what content they need, what command to run against them, and what output confirms success. Coder follows these instructions precisely; do not leave scaffold design to Coder.
- **Real-scenario tests** — design test cases that cover the actual usage path, not isolated unit assertions.

If no available technique can emulate what's needed, raise it with PO and agree on the gap before finalising. A check is truly unverifiable locally only when it requires infrastructure the container cannot emulate (built Docker image, live external service).

**Plans describe, not implement.** Include only descriptions and illustrative snippets — never complete, runnable implementations. Writing full code in the plan preempts implementation decisions that belong to Coder.

Iterate with PO in plan mode until the plan is approved.

### 3. Post plan

Post the approved plan as a comment to the issue:

```bash
gh issue comment {issue-id} --body-file {path-to-plan-file}
```

**Do not proceed to step 4 until the comment has been posted.**

### 4. Feature branch

Branch names follow the pattern `{type}/{issue-id}-{slug}` — for example: `feature/42-avif-support`, `chore/37-add-claude-md`, `docs/51-timeout-handling`.

**Before modifying any repository files**, ensure the feature branch exists and is checked out:

```
/usr/local/libexec/adda-dev-runtime/bin/current-issue branch --ensure
```

This is idempotent: if no linked branch exists it creates one, links it to the issue, and checks out the workspace onto it; if already on the correct branch it is a no-op. The branch name is derived from the current issue as `{type}/{issue-id}-{slug}`. If the command exits non-zero, stop and ask PO.

On an existing branch, verify the working tree is clean before dispatching Coder or making repository changes. If there are unrelated dirty changes, stop and ask PO.

**NEVER commit to `main` directly**. NEVER merge PRs — merging is a strictly manual human operation that acts as a gate.

### 5. Implement

Dispatch the Coder agent (name for `Agent` tool: `coder`) with: issue ID, title, type, path to the plan file (instruct Coder to treat it as `impl-plan.md`), and any additional context from the conversation.

After Coder terminates and returns the structured response, read it. If the outcome resulted in changes committed and pushed to the feature branch, proceed to step 5a. If no commit was made (partial or escalated status), confirm by checking the git log on the branch, then proceed to step 6 directly.

### 5a. Monitor CI after Coder push

Ensure CI is green on the current feature branch using the `ci-gate` skill. Step 5a is not complete until `ci-gate` resolves green.

### 6. Post outcome

Write Coder's final response verbatim to `/tmp/{issue-id}-coder-response.md`. Preserve every line — even empty sections — as-is for future reference.

After saving the file, post Coder's response as a comment to the issue:

```bash
gh issue comment {issue-id} --body-file "/tmp/{issue-id}-coder-response.md"
```

**Do not proceed to step 7 until the comment has been posted.**

### 7. Open PR and watch PR checks

Verify all commits are pushed (`git push` if needed — Coder pushes as part of its work, but confirm nothing is outstanding). Then open a pull request if not yet open (only during the first review iteration). **If the PR is already opened, proceed to PR checks monitoring directly.**

To open PR, run:

```bash
gh pr create --title "{issue-id} - [{type}] {description}" --body "..."
```

PR title follows the format `{issue-id} - [{type}] {description}` — for example `272 - [docs] Add ADDA project onboarding guide` or `377 - [bug] Fix new-issue skill AskUserQuestion calls`. The `issue-id` links the PR to the issue, the `type` matches the issue type label (`feature`, `chore`, `docs`, `bug`), and the `description` is a short summary of the change.

When the PR is opened, watch PR checks using the `ci-gate` skill. Step 7 is not complete until `ci-gate` resolves green.

After PR checks pass, sync the issue state to reflect the PR's current state:

```bash
/usr/local/libexec/adda-dev-runtime/bin/current-issue sync --issue-state-only
```

### 8. Review

Output the full contents of `/tmp/{issue-id}-coder-response.md` verbatim in your response message as Markdown. Do not summarize. Reading the file with the Read tool is not sufficient — tool results are not visible to PO. The goal is to ensure Coder's outcome correctly implements the plan, and to identify gaps, code smells, or follow-up items.

PO might leave comments in the PR (general or attached to diff lines) or provide feedback directly in the conversation. Get an explicit answer from PO: is the PR approved or does it require a **delta plan iteration**?

**PR comments with questions.** When PO asks a question in a PR comment, answer it directly in the conversation — do not answer by modifying the document or code. Only make changes if PO explicitly asks for them. Interpreting a question as a change request bypasses the discussion step and risks building in the wrong direction.

Fetch the PR's general conversation and its review threads:

```
gh pr view {pr-number} --comments
/usr/local/libexec/adda-dev-runtime/bin/pr-review-threads pr {pr-number}
```

`gh pr view --comments` returns the general PR conversation. `pr-review-threads pr {pr-number}` returns the **unresolved review threads** (resolution state + thread grouping) as a JSON envelope on stdout, and writes the full detail to a file.

**On success** (`status: "ok"`, exit 0) read `.result.resultsFile` and `jq` the file for detail:

```json
{
    "status": "ok",
    "result": {
        "pr": {
            "number": 306,
            "total": 12,
            "unresolved": 3,
            "resolved": 9,
            "returnedUnresolved": 3,
            "moreUnresolvedAvailable": false,
            "maxUnresolved": 50
        },
        "resultsFile": "/tmp/pr-review-threads-pr-306-<ts>.json"
    },
    "error": null
}
```

- `unresolved` is the true count; `returnedUnresolved` is how many are in the file (windowed at `maxUnresolved`). If `moreUnresolvedAvailable` is `true`, the remainder surfaces after addressed threads are resolved.
- Detail file shape: `{ pr:{…header…}, threads:[ {id, path, line, isOutdated, targetLine, hunkPreview, comments:[{author, body, url, createdAt}]} ], hunks:{ id → full diff hunk } }`. Slice with `jq '[.threads[] | {id, path, line, isOutdated, body: .comments[0].body}]' <file>`; pull a full hunk via `jq '.hunks["<id>"]' <file>`. A thread flagged `commentsTruncated:true` has more comments than the inline preview — fetch them all with `pr-review-threads thread <id>`.

**On error** (`status: "fail"`, non-zero exit, **no file written**) the envelope carries `error` with `reason` directly:

```json
{
    "status": "fail",
    "result": null,
    "error": { "reason": "pr_not_found", "message": "PR #999 not found in owner/repo", "details": {} }
}
```

Branch on `error.reason`: `pr_not_found` / `repo_not_found` / `missing_env` / `invalid_config` are operator errors — fix and retry. `scan_limit_exceeded` (carries `total` + `ceiling` in `details`) means the PR has more review threads than the safe ceiling — surface to PO rather than raising the ceiling. Never read `resultsFile` on a non-zero exit; no file is written on the error path.

If PO is satisfied, the next step is on PO: **merge the PR**. Active PM work pauses until PO manually merges. If PO reports the merge, proceed to step 10.

If PO does not approve, proceed to step 9.

### 9. Iterate (if PO does not approve yet)

Start over from step 2. Enter plan mode and write a **delta plan** — overwrite the designated plan file scoped only to what needs to change from what Coder already implemented. The review conversation and PR comments are the primary source for the scope. The issue comment thread (plan/outcome pairs) is the baseline; do not restate work done correctly. Post the delta plan as a comment (step 3), then dispatch Coder (step 5). Each iteration produces its own plan/outcome comment pair on the issue.

### 10. Monitor main after merge (conditional)

This step is triggered only if PO explicitly reports that the PR was merged. Do not prompt PO for merge status — if PO does not mention it, skip this step.

If PO reports the merge, ensure CI is green on main using the `ci-gate` skill. Main is healthy when `ci-gate` resolves green.

After CI is green, sync the full issue state (refreshes local state and moves to main):

```bash
/usr/local/libexec/adda-dev-runtime/bin/current-issue sync
```

## Cutting a release

Releases are tagged from `main`. The `release` workflow fires on any `v*` tag push and handles image stamping, retagging, launcher packaging, and GitHub release creation automatically.

**Steps:**

1. Confirm `main` CI is green.
2. Summarize changes since the previous release and present the delta to PO:
    ```bash
    git log $(git describe --tags --abbrev=0)..HEAD --oneline
    ```
    Ask PO for the version number — PM never picks the version.
3. Tag and push:
    ```bash
    git tag vX.Y.Z
    git push origin vX.Y.Z
    ```
4. Ensure the release workflow completes successfully using the `ci-gate` skill. The release is not complete until `ci-gate` resolves green.
5. Verify the resulting GitHub release has the launcher tarball attached.

**Do not use `gh release create`.** It is on the deny list and will be blocked. Pushing the tag is the only correct trigger — the `release` workflow owns creation. Using `gh release create` publishes the release immediately and empty; the workflow's later launcher-tarball upload is rejected because assets cannot be added to a published release. Recovering from this burns the version number.
