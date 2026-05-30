---
name: go-go
description: Kick off work on an issue. Resolves issue ID from: explicit argument → ISSUE_ID env var → prompt PO. Use at the start of a session to begin working on a tracked issue.
disable-model-invocation: true
arguments: issue_id
allowed-tools: Bash(printenv ISSUE_ID), Bash(gh issue view *), Write(~/.issue)
---

# go

Kick off work on a GitHub issue.

## Issue ID resolution

1. If `$issue_id` is non-empty (an argument was passed to `/go`), use it as the issue ID.
2. Otherwise, run `printenv ISSUE_ID`. If the output is set and non-empty, use that value.
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

**Format:**

```
Issue:    #<id>
Title:    <title>
Type:     <type label, or "(no type label)">
Phase:    <phase label, or "(no phase label)">
Body:     <first 120 chars of body, or "(no description)">
Comments: <count or "(no comments)">
```

**How to fill each field:**
- **`Type:`** — include the label whose value is one of `feature`, `bug`, `chore`, or `docs`. If no such label exists, include `(no type label)` and add a one-line warning under the block that the issue may be misconfigured — but do not block the work on it.
- **`Phase:`** — include the label whose value is one of `phase: triage`, `phase: spec`, `phase: tech-design`, `phase: impl-plan`, `phase: impl-coding`, `phase: impl-docs`, `phase: impl-done`, `phase: merged`, `phase: released`. If no such label exists, include `(no phase label)` and add a one-line warning under the block that the issue may be misconfigured — but do not block the work on it.
- **`Body:`** — include the first ~120 characters of the issue body, with `…` appended if truncated. If the body is empty, include `(no description)`.
- **`Comments:`** - include only the count of comments, not the actual text. If there are no comments yet, include `(no comments)`

## Write the ~/.issue file 

Before starting the work on the new issue, update the system state to track the current issue at work. To do that, use `Write` tool to write the file `~/.issue` (hidden file in current user's home folder) with the following contents:

```
ID=<id>
TITLE=<title>
TYPE=<type label>
PHASE=<phase label>
```

Fill the field values exactly the same as in the preview. If the file does not exist yet, create it.

## Start work

Begin working on the confirmed issue. Run  to read the full comment history, then follow the project workflow as defined in CLAUDE.md.
