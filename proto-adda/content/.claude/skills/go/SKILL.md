---
name: go
description: Kick off work on an issue. Resolves issue ID from: explicit argument → ISSUE_ID env var → prompt PO. Use at the start of a session to begin working on a tracked issue.
disable-model-invocation: true
argument-hint: [issue-id]
arguments: issue_id
allowed-tools: Bash(printenv ISSUE_ID), Bash(gh issue view *)
---

# go

Kick off work on a GitHub issue.

## Issue ID resolution

1. If `$issue_id` is non-empty (an argument was passed to `/go`), use it as the issue ID.
2. Otherwise, run `printenv ISSUE_ID`. If the output is set and non-empty, use that value.
3. Otherwise, use `AskUserQuestion`: "Which issue should we work on?" — free-text input for the issue number.

## Read and confirm

Run the following command for the resolved issue ID:

```bash
gh issue view {id} --json title,body,labels
```

If the command fails, surface the error verbatim and stop. If the error indicates the issue does not exist, suggest creating one with `/new-issue`.

Extract the type label: the label whose value is one of `feature`, `bug`, `chore`, or `docs`. If none is found, use `(no type label)` and surface a warning that the issue may be misconfigured — but do not block confirmation.

Extract the body: truncate to ~120 characters with `…` if longer; use `(no description)` if empty.

Display the following to PO in a plain code block:

```
Issue: #<id>
Title: <title>
Type:  <type label, or "(no type label)">
Body:  <first 120 chars of body, or "(no description)">
```

Then use `AskUserQuestion`: "Start working on this issue?" with options:
- "Yes, start work"
- "Use a different issue"

If PO selects "Use a different issue": ask in plain text "Enter the issue number:", capture the answer as the new ID, then repeat this section from the top with the new ID.

## Start work

Begin working on the confirmed issue. Run `gh issue view {id} --comments` to read the full comment history, then follow the project workflow as defined in CLAUDE.md.
