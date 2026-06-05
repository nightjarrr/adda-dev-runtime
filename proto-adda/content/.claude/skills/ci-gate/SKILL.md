---
name: ci-gate
description: >
  Invoke when CI must pass before the current SDLC step can proceed. Dispatches
  ci-monitor, interprets the result, iterates on code_fix failures with a
  loop-break rule, and applies context-aware triage. The current step is not
  complete until this skill resolves green.
user-invocable: false
---

# CI Gate

## Invariant

The current SDLC step is not complete until ci-gate resolves green. Do not proceed, report partial success, or surface CI status to PO while this skill is active.

## Dispatch ci-monitor

Determine the mode and ref from the instruction you received. The dispatch consists of exactly two inputs — mode and ref. Include nothing else.

| Context | mode | ref |
|---|---|---|
| Feature branch push (step 5a) | `branch` | `LOCAL` |
| PR checks (step 7) | `pr` | `<pr-number>` |
| Post-merge main (step 10) | `branch` | `main` |
| Release tag | `tag` | `<tag-version>` |

**Examples:**

Ensure CI is green on the current feature branch:
> mode: branch, ref: LOCAL

Watch PR #257 checks:
> mode: pr, ref: 257

Ensure CI is green after merge to main:
> mode: branch, ref: main

Ensure release workflow completes for v0.4.1:
> mode: tag, ref: v0.4.1

Dispatch the `ci-monitor` agent (subagent name: `ci-monitor`) with the mode and ref. Wait for the structured result.

## On success result

Report to PO: CI is green (include elapsed time from ci-monitor's result). Then proceed with the SDLC step.

## On error result

ci-monitor returns `**Result:** error` when ci-watch itself could not run. Act as follows:

- **Timing indicator** (detail contains "no push run found") — return to **Dispatch ci-monitor** and retry once. If the retry also returns `error`, surface the detail to PO and wait for direction.
- **Ref resolution error** (detail contains "cannot resolve branch", "cannot resolve tag", "cannot resolve" a PR or commit) — two sub-cases:
  - *Format mismatch*: the ref doesn't match the expected syntax for the mode — a `pr` ref should be a plain integer; a `branch` ref should be a valid branch name (no spaces, not a bare number); a `tag` ref should match a version pattern (e.g. `vX.Y.Z`). If clearly violated, re-dispatch once with a corrected ref.
  - *Correct format, wrong data*: the ref is syntactically valid but drawn from the wrong identifier — e.g., an issue ID used where a PR number was expected. Check the dispatch context: if PM can identify the correct value from context, re-dispatch once with it.
  - In either sub-case, if the re-dispatch also returns `error`, or no correction can be identified, surface the detail to PO and wait for direction.
- **Any other error** — surface the detail to PO immediately and wait for direction.

## On failure result

Act on the classification and your current context.

### transient (any context)

Surface ci-monitor's result to PO including the failing run URL. Ask PO to re-run the failed workflow. Wait for PO confirmation, then return to **Dispatch ci-monitor** above and dispatch again.

### ci_infra (any context)

Surface ci-monitor's full result to PO. Wait for PO direction before proceeding.

### unclear (any context)

Surface ci-monitor's full result to PO. Wait for PO direction before proceeding.

### code_fix

**Feature branch context** (steps 5a and 7):

Dispatch Coder (`coder` subagent) with: the current implementation plan, Coder's previous structured response, and ci-monitor's result. Increment the consecutive `code_fix` counter. When Coder finishes, return to **Dispatch ci-monitor** above and dispatch again.

> If no previous Coder response exists (e.g. a docs issue handled in-session), PM summarizes its own recent changes into an equivalent structured input before dispatching.

**Post-merge main context** (step 10):

Do not commit or push to main. Surface ci-monitor's result to PO. Propose the following path forward: reopen the issue, recreate the feature branch, and follow the full SDLC process from step 2 to produce a fix via the normal PR gate.

**Release/tag context**:

Surface ci-monitor's result to PO. Propose a recovery path for PO to consider: create a fix branch, route the fix through the normal PR gate, then cut a new tag once main is green. Wait for PO's direction before taking any action.

## Loop-break rule

Track consecutive `code_fix` dispatches in the current loop. The counter resets to zero on any green run; only `code_fix` increments it.

After **3 consecutive `code_fix` failures**: stop the loop. Compile a per-iteration summary — for each of the 3 failed iterations, note what ci-monitor identified as the root cause and what fix Coder attempted. Surface this summary to PO and wait for direction.
