---
name: ci-gate
description: >
  Invoke when CI must pass before the current SDLC step can proceed — e.g. to
  monitor CI on a feature branch push, watch PR checks, track CI after a merge
  to main, or verify a release tag workflow. Dispatches ci-monitor, interprets
  the result, iterates on code_fix failures with a loop-break rule in the coding
  phase, and applies context-aware triage. The current step is not complete
  until CI is green.
user-invocable: false
---

# CI Gate

## Invariant

The current SDLC step is not complete until CI is green. Do not advance to the next SDLC step, report partial success, or surface CI status to PO while this skill is active. While waiting for ci-monitor to complete, PM may engage in small side conversations with PO (clarify a question, create a follow-up issue, make a note) — but must not advance the SDLC until the background completion notification arrives and the result is processed.

## Dispatch ci-monitor

Determine the `mode` and `ref` from the current context. The dispatch consists of exactly two inputs — `mode` and `ref`. Include nothing else.

| Context | mode | ref |
|---|---|---|
| Feature branch push | `branch` | `LOCAL` |
| PR checks | `pr` | `<pr-number>` |
| Post-merge main | `branch` | `main` |
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

Dispatch the `ci-monitor` agent (subagent name: `ci-monitor`) with the `mode` and `ref`. Set `run_in_background: true` on the Agent call. Wait for the background completion notification, then read the structured result.

`ci-monitor` returns one of three result shapes:

**Success:**
```
**Result:** success
**Elapsed:** 53s
```

**Error** (`ci-watch` itself failed to run):
```
**Result:** error
**Detail:** [error content]
```

**Failure** (CI ran but did not pass):
```
**Result:** failure
**Elapsed:** 87s
**Classification:** [transient | ci_infra | code_fix | unclear]
**Run URL:** https://github.com/...
**Root Cause:** ...
**Affected Locations:** ...
**Evidence:** ...
**Confidence:** [high | medium | low]
```

## On success result

Report the result to PO with 🟢🟢:

```
🟢🟢 CI is green (<elapsed>)
```

Then proceed with the SDLC step.

## On error result

Report the result to PO with 🟡🟡:

```
🟡🟡 <detail>
```

`ci-monitor` returns `**Result:** error` when the `ci-watch` script itself could not run. Act as follows:

- **Timing indicator** (detail contains "no push run found" or similar, indicating the script ran before CI infrastructure had a chance to schedule the runs) — return to **Dispatch ci-monitor** and retry once. If the retry also returns `error`, surface the 🟡🟡 detail to PO and wait for direction.
- **Ref resolution error** (detail contains "cannot resolve branch", "cannot resolve tag", "cannot resolve" a PR or commit) — two sub-cases:
  - *Format mismatch*: the ref doesn't match the expected syntax for the mode — a `pr` ref should be a plain integer; a `branch` ref should be a valid branch name (no spaces, not a bare number); a `tag` ref should match a version pattern (e.g. `vX.Y.Z`). If clearly violated, re-dispatch once with a corrected ref.
  - *Correct format, wrong data*: the ref is syntactically valid but drawn from the wrong identifier — e.g., an issue ID used where a PR number was expected. Check the dispatch context: if you can identify the correct value from context, re-dispatch once with it.
  - In either sub-case, if the re-dispatch also returns `error`, or no correction can be identified, surface the 🟡🟡 detail to PO and wait for direction.
- **Any other error** — surface the 🟡🟡 detail to PO immediately and wait for direction.

## On failure result

Report the result to PO with 🔴🔴:

```
🔴🔴 CI failed
Classification: <type>
Run URL: <url>
```

Act on the `classification` field and the current SDLC context.

### transient (any context)

Surface 🔴🔴 `ci-monitor`'s result to PO including the failing run URL. Ask PO to re-run the failed workflow — the GitHub access token does not grant permission to trigger workflow re-runs directly. Wait for PO confirmation, then return to **Dispatch ci-monitor** above and dispatch again.

### ci_infra (any context)

Surface 🔴🔴 `ci-monitor`'s full result to PO. Wait for PO direction before proceeding.

### unclear (any context)

Surface 🔴🔴 `ci-monitor`'s full result to PO. Wait for PO direction before proceeding.

### code_fix

Depending on the current SDLC stage, handling differs:

#### Active coding phase (feature branch or PR checks context)

Dispatch Coder (`coder` subagent) with: the current implementation plan, Coder's previous structured response, and `ci-monitor`'s failure analysis result. When Coder finishes, return to **Dispatch ci-monitor** above and dispatch again.

> If no previous Coder response exists (e.g. a change was made directly in-session rather than via Coder dispatch), summarize your own recent changes into an equivalent structured input before dispatching.

**Loop-break:** Track consecutive `code_fix` dispatches. The counter resets to zero on any green run, `transient`, `ci_infra`, or `unclear` failure; only `code_fix` increments it. After **3 consecutive `code_fix` failures**: stop the loop. Compile a per-iteration summary — for each of the 3 failed iterations, note what `ci-monitor` identified as the root cause and what fix was attempted. Surface this 🔴🔴 summary to PO and wait for direction.

#### Post-merge main context

Do not commit or push to main. Surface 🔴🔴 `ci-monitor`'s result to PO. Propose the following path forward: reopen the issue, recreate the feature branch, and follow the full SDLC process to produce a fix via the normal PR gate.

#### Release/tag context

Surface 🔴🔴 `ci-monitor`'s result to PO. Propose a recovery path for PO to consider: create a fix branch, route the fix through the normal PR gate, then cut a new tag once main is green. Wait for PO's direction before taking any action.
