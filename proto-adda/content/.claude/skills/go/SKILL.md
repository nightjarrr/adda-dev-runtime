---
name: go
description: Kick off work on an issue. Resolves issue ID from: explicit argument → ISSUE_ID env var → prompt PO. Human-invocable only.
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

Run both commands for the resolved issue ID:

```bash
gh issue view {id} --json title,body,labels
gh issue view {id} --comments
```

If either command fails, surface the error verbatim and stop. If the error indicates the issue does not exist, suggest creating one with `/new-issue`.

Display the following to PO:
- Issue number
- Title
- Type label (the label whose value is one of `feature`, `bug`, `chore`, or `docs`)

Then use `AskUserQuestion`: "Start working on this issue?" with options:
- "Yes"
- "Use a different issue"

If PO selects "Use a different issue": use `AskUserQuestion` to ask for the new issue ID (free-text), then repeat this section from the top with the new ID.

## Start work

Tell PM to begin working on the confirmed issue.
