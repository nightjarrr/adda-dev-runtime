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

## Read the issue

Run the following command for the resolved issue ID:

```bash
gh issue view {id} --json title,body,labels
```

If the command fails, surface the error verbatim and stop. If the error indicates the issue does not exist, suggest creating one with `/new-issue`.

## Show preview

PO needs to confirm the resolved issue is the one they want to work on. The raw JSON from `gh issue view` is already in the bash output but is hard to scan at a glance — especially when the body is long or contains markdown. A formatted preview block makes confirmation fast and unambiguous, and forces the model to commit to a concrete reading of the issue (type label, title, body summary) before asking PO to approve it.

The preview block must appear as plain response text in the message immediately before the `AskUserQuestion` call in the next section. It is not optional output, and "the JSON is already visible" is not a reason to skip it — the JSON and the preview serve different purposes.

Format:

```
Issue: #<id>
Title: <title>
Type:  <type label, or "(no type label)">
Body:  <first 120 chars of body, or "(no description)">
```

How to fill each field:

- **`Type:`** — include the label whose value is one of `feature`, `bug`, `chore`, or `docs`. If no such label exists, include `(no type label)` and add a one-line warning under the block that the issue may be misconfigured — but do not block confirmation.
- **`Body:`** — include the first ~120 characters of the issue body, with `…` appended if truncated. If the body is empty, include `(no description)`.

## Confirm

After the preview block, invoke `AskUserQuestion`:
- Question: "Start working on this issue?"
- Options:
  - "Yes, start work"
  - "Use a different issue"

If PO selects "Use a different issue" without appending the issue ID in the answer: ask in plain text "Enter the issue number:", capture the answer as the new ID, then repeat the *Read the issue*, *Show preview*, and *Confirm* sections with the new ID.

## Start work

Begin working on the confirmed issue. Run `gh issue view {id} --comments` to read the full comment history, then follow the project workflow as defined in CLAUDE.md.
