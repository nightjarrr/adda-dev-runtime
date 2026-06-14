---
name: go
description: Kick off work on an issue. Resolves issue ID from: explicit argument → current-issue get id → prompt PO. Use when starting work on an issue or switching to a different issue mid-session.
disable-model-invocation: true
allowed-tools: Bash(/usr/local/libexec/adda-dev-runtime/bin/current-issue *), Bash(git status --porcelain), Bash(gh issue view *), Read(/workspace/CLAUDE.local.md)
---

# go

Kick off work on a GitHub issue.

## Issue ID resolution

1. If the user passed a numeric argument to `/go`, use it as the issue ID.
2. Otherwise, run `/usr/local/libexec/adda-dev-runtime/bin/current-issue get id`. If the output is non-empty, use it as the issue ID.
3. Otherwise, ask user directly: "Which issue should we work on?" — expect the user to provide a free-text input for the issue number or request to create a new one.

## Read the issue and comments

Run the following commands for the resolved issue ID:

```bash
gh issue view {id} --json title,body,labels
gh issue view {id} --comments
```

If the commands fails, surface the error verbatim and stop. If the error indicates the issue does not exist, suggest creating one.

## Show preview

Once the issue ID is resolved to a specific value, the user needs to see a short summary of the resolved issue before starting the work on it. The raw JSON from `gh issue view` is already in the bash output but is hard to scan at a glance — especially when the body is long or contains markdown. 

The preview block must appear as plain response text in the message immediately before starting the work on it in the next section. It is not optional output, and "the JSON is already visible" is not a reason to skip it — the JSON and the preview serve different purposes.

### Format

```
Issue:    #<id>
Title:    <title>
Type:     <type label, or "(no type label)">
Phase:    <phase label, or "(no phase label)">
Body:     <first 120 chars of body, or "(no description)">
Comments: <count or "(no comments)">
```

### How to fill each field
- **`Type:`** — include the label whose value is one of `feature`, `bug`, `chore`, or `docs`. If no such label exists, include `(no type label)` and add a one-line warning under the block that the issue may be misconfigured — but do not block the work on it.
- **`Phase:`** — include the label whose value is one of `phase: triage`, `phase: spec`, `phase: tech-design`, `phase: impl-plan`, `phase: impl-coding`, `phase: impl-docs`, `phase: impl-done`, `phase: merged`, `phase: released`. If no such label exists, include `(no phase label)` and add a one-line warning under the block that the issue may be misconfigured — but do not block the work on it.
- **`Body:`** — include the first ~120 characters of the issue body, with `…` appended if truncated. If the body is empty, include `(no description)`.
- **`Comments:`** - include only the count of comments, not the actual text. If there are no comments yet, include `(no comments)`

### Examples

Minimal issue without expected labels:
```
Issue:    #133
Title:    Make build faster
Type:     (no type label)
Phase:    (no phase label)
Body:     (no description)
Comments: (no comments)

Warning: the type and phase labels are missing on this issue, it might be misconfigured.
```

Fresh bug issue with all details but without comments, body truncated to 120 characters with ellipsis (...):
```
Issue:    #137
Title:    Fix race condition bug during startup
Type:     bug
Phase:    phase: triage
Body:     During startup in rare cases when the authorization service call is delayed or times out the database connection is esta...
Comments: (no comments)
```

Merged but not released feature with extensive comment chain, short body, not truncated:
```
Issue:    #137
Title:    User should be able to save preferences in browser's localStorage
Type:     feature
Phase:    phase: merged
Body:     PreferenceService should automatically save user's preferences into browser's localStorage each time a value changes.
Comments: 14
```

## Switch to issue

Before starting the work on the new issue, register the current issue state using `current-issue switch`.

1. Run `git status --porcelain`. If the output is non-empty (dirty working tree), surface the dirty-tree state to PO via `AskUserQuestion` and do not proceed until PO confirms or resolves the dirty tree.
2. Run `/usr/local/libexec/adda-dev-runtime/bin/current-issue switch <id>`. The command emits a JSON envelope to stdout. Two representative shapes:

   Success — feature branch resolved:
   ```json
   {
     "status": "ok",
     "result": {
       "issue": { "id": "42", "title": "Add AVIF support", "type": "feature", "phase": "phase: impl-plan", "state": "OPEN", "pr": "37" },
       "details": { "branch": "feature/42-avif-support", "resolution": "feature_branch", "hook": { "status": "ok", "output": "..." } }
     },
     "error": null
   }
   ```

   Error — hook failure (details carries context):
   ```json
   {
     "status": "fail",
     "result": null,
     "error": { "reason": "hook_failed", "message": "repo init hook failed", "details": { "hook": { "status": "failed", "output": "bun install failed: ..." } } }
   }
   ```

3. If the exit code is non-zero or `status` is `"fail"`, surface the `error.message` and `error.details` to PO and stop.
4. After a successful switch, check whether `/workspace/CLAUDE.local.md` exists. If it does, read it and follow the instructions in it before proceeding to the workflow. (`CLAUDE.local.md` is gitignored and always deleted at the start of each hook run — presence means it was freshly written for this context, relevant to the current branch.)

## Start work

Begin working on the confirmed issue by following the project workflow as defined in CLAUDE.md.
