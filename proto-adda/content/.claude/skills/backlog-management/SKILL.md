---
name: backlog-management
description: |
  Handle backlog queries and management tasks. Must be loaded whenever the conversation involves:

  Navigating issue hierarchies:
  - "what's under #N" / "show children of"
  - "what's the parent of #N" / "show the parent"
  - "what are the siblings of #N" / "show siblings"
  - "list orphans" / "find root-level issues" / "what has no parent"

  Searching and filtering issues:
  - "find issues about X" / "search for X in issues"
  - "list open bugs" / "show all chores" / "what's in phase: triage"
  - "show me the backlog" / "what issues are in scope"

  Managing issue relationships:
  - "move #N under #M" / "reparent" / "change the parent"
  - "break #N down into sub-issues" / "create sub-issues for"

  Backlog health awareness:
  - "are all issues assigned to an epic?" / "any stray issues?"
  - "show me unparented issues" (orphans)
allowed-tools: |
  Bash(/usr/local/libexec/adda-dev-runtime/bin/issue-hierarchy *),
  Bash(gh search issues *),
  Bash(gh issue list *),
  Skill(new-issue)
user-invocable: false
---

# Backlog Management

Reference for handling backlog-related tasks — querying issue hierarchies, searching/filtering issues, and managing issue relationships.

## Querying hierarchies with `issue-hierarchy`

All `issue-hierarchy` subcommands emit a JSON envelope on stdout. Parse and branch on `status` — result or error shapes are the same across all hierarchy subcommands.

**Success envelope:**
```json
{ "status": "ok", "result": { ... }, "error": null }
```

**Failure envelope:**
```json
{ "status": "fail", "result": null, "error": { "reason": "<reason_code>", "message": "<human message>", "details": {} } }
```

Failure reason codes: `invalid_args` (bad input, exit 2), `shell_error` (gh API call failed, exit 1), `validation_error` (API response didn't match expected schema, exit 1), `internal_error` (write-then-verify mismatch, exit 1).

---

### Children — list sub-issues of an issue

Use when the user asks what's under an epic or parent issue.

```bash
/usr/local/libexec/adda-dev-runtime/bin/issue-hierarchy children <number>
```

**Success — has children:**
```json
{
  "status": "ok",
  "result": {
    "parent": 10,
    "children": [
      {
        "number": 101,
        "title": "First child",
        "state": "open",
        "type": "feature",
        "phase": "phase: planning",
        "parent": 10,
        "labels": ["feature", "phase: planning"]
      }
    ]
  },
  "error": null
}
```

**Success — no children:**
```json
{
  "status": "ok",
  "result": { "parent": 10, "children": [] },
  "error": null
}
```

**Interpretation:**
- `result.children` is always an array. Length 0 means no sub-issues.
- Each child has `number`, `title`, `state` (`"open"`/`"closed"`), `type` (first matching label or null), `phase` (first `phase:` label or null), `parent`, and `labels[]`.
- Present the list to PO in a scannable format (table or bullet list), noting closed/merged status.

---

### Parent — get or set the parent of an issue

Use when the user asks about an issue's parent, wants to reparent, or wants to detach.

**Read parent:**
```bash
/usr/local/libexec/adda-dev-runtime/bin/issue-hierarchy parent <number>
```

**Success — has parent:**
```json
{
  "status": "ok",
  "result": {
    "issue": 42,
    "parent": {
      "number": 10,
      "title": "Parent issue",
      "state": "open",
      "type": "feature",
      "phase": null,
      "parent": null,
      "labels": ["feature"]
    }
  },
  "error": null
}
```

**Success — no parent (root-level):**
```json
{
  "status": "ok",
  "result": { "issue": 42, "parent": null },
  "error": null
}
```

**Set parent (reparent):**
```bash
/usr/local/libexec/adda-dev-runtime/bin/issue-hierarchy parent <child-number> --set <parent-number>
```

**Unset parent (detach):**
```bash
/usr/local/libexec/adda-dev-runtime/bin/issue-hierarchy parent <child-number> --set NONE
```

**Success — parent set:**
```json
{
  "status": "ok",
  "result": {
    "issue": 5,
    "parent": {
      "number": 10,
      "title": "New parent",
      "state": "open",
      "type": "feature",
      "phase": null,
      "parent": null,
      "labels": ["feature"]
    }
  },
  "error": null
}
```

**Success — parent unset:**
```json
{
  "status": "ok",
  "result": { "issue": 5, "parent": null },
  "error": null
}
```

**Interpretation:**
- `result.parent` is `null` when the issue is root-level. Tell the user it has no parent.
- `result.parent` is an object when it has a parent. Include the parent title in your response.
- On `--set` / `--set NONE`, success means the operation completed and was verified by re-fetching.
- On failure with `reason: "shell_error"` and a 404 in stderr, the target parent does not exist. Suggest checking the issue number.
- On `reason: "internal_error"`, the relationship was set but verification failed — the link may have taken effect. Suggest manual verification via `issue-hierarchy parent <N>`.

---

### Siblings — list sibling issues

Use when the user asks "what else is under the same parent" or "show siblings".

```bash
/usr/local/libexec/adda-dev-runtime/bin/issue-hierarchy siblings <number>
```

**Success — has siblings:**
```json
{
  "status": "ok",
  "result": {
    "issue": 5,
    "siblings": [
      {
        "number": 7,
        "title": "Sibling A",
        "state": "open",
        "type": "feature",
        "phase": null,
        "parent": 10,
        "labels": ["feature"]
      }
    ]
  },
  "error": null
}
```

**Success — no parent or no siblings:**
```json
{
  "status": "ok",
  "result": { "issue": 5, "siblings": [] },
  "error": null
}
```

**Interpretation:**
- `result.siblings` is `[]` when the issue has no parent (and therefore no siblings) or is the only child.
- Each sibling has the same `GitHubIssueHeader` shape as children above.
- Filter based on `state` if the user wants only open/closed siblings.

---

### Orphans — list root-level issues

Use when the user asks for issues with no parent, "unparented issues", or "stray issues".

```bash
/usr/local/libexec/adda-dev-runtime/bin/issue-hierarchy orphans
```

Include closed issues:
```bash
/usr/local/libexec/adda-dev-runtime/bin/issue-hierarchy orphans --include-closed
```

**Success — orphans found:**
```json
{
  "status": "ok",
  "result": {
    "orphans": [
      {
        "number": 1,
        "title": "Orphan issue",
        "state": "open",
        "type": "feature",
        "phase": null,
        "parent": null,
        "labels": ["feature"]
      }
    ]
  },
  "error": null
}
```

**Success — no orphans (all issues have parents):**
```json
{
  "status": "ok",
  "result": { "orphans": [] },
  "error": null
}
```

**Interpretation:**
- By default only open issues are returned. Pass `--include-closed` when the user wants the full picture (e.g., backlog health check).
- Each orphan has `parent: null` by definition.
- If the user wants to clean up orphans, suggest reparenting via `issue-hierarchy parent <N> --set <M>` or discuss with PO which epic each orphan belongs to.

---

## Searching and listing issues with `gh`

Unlike `issue-hierarchy`, `gh` commands emit raw JSON arrays on stdout — not the `{status, result, error}` envelope. Error handling is by exit code.

### `gh search issues` — free-text search

Use when the user wants to find issues across the repo by keyword, description, or any GitHub search qualifier.

```bash
gh search issues "<query>" \
  --repo nightjarrr/adda-dev-runtime \
  --json number,title,state,labels,url \
  --limit 30
```

**Success — matches found:**
```json
[
  {
    "number": 348,
    "title": "Add backlog skill for hierarchy-aware issue traversal",
    "state": "open",
    "labels": [
      { "name": "chore", "color": "C5DEF5", "description": "Non-functional work: CI, dependencies, configuration, releases" }
    ],
    "url": "https://github.com/nightjarrr/adda-dev-runtime/issues/348"
  }
]
```

**Success — no matches:**
```json
[]
```

**Failure:** The command exits non-zero and writes an error message to stderr. Report the error to the user and stop — do not retry silently.

**Available JSON fields:** `assignees`, `author`, `body`, `closedAt`, `commentsCount`, `createdAt`, `id`, `isLocked`, `isPullRequest`, `labels`, `number`, `repository`, `state`, `title`, `updatedAt`, `url`.

**Common qualifiers (appended to the query string):**
- `is:open` / `is:closed` — filter by state
- `label:<name>` — filter by label (can repeat: `label:bug label:phase:triage`)
- `no:label` — issues without a label
- `author:@me` — issues created by you

**Interpretation:**
- The result is always a JSON array. Empty array = no matches.
- Each element has `state` as lowercase (`"open"`, `"closed"`).
- `labels` is an array of `{name, color, description}` objects. Extract `name` for display.
- Consider the result size and page size — `--limit N` controls max results (default varies by gh version; always set explicitly). Use limits of 20-50 for conversational use; higher for data collection tasks.

---

### `gh issue list` — filter by state and labels

Use when the user wants to list issues by label, state, author, or other issue-scoped filters (not free-text search).

```bash
gh issue list \
  --json number,title,state,labels,url \
  --label "<type>" \
  --state open \
  --limit 30
```

**Success — issues found:**
```json
[
  {
    "number": 358,
    "title": "Streamline new-issue skill to infer title and body from conversational input",
    "state": "OPEN",
    "labels": [
      { "name": "docs", "color": "E99695", "description": "Documentation-only changes" },
      { "name": "phase: triage", "color": "C5DEF5", "description": "Newly created, awaiting triage by Project Owner or in process of triage" }
    ],
    "url": "https://github.com/nightjarrr/adda-dev-runtime/issues/358"
  }
]
```

**Success — no matching issues:**
```json
[]
```

**Common filters:**
- `--label <name>` — filter by label (repeatable: `--label bug --label "phase: triage"` for intersection within a type+phase query)
- `--state open|closed|all` — defaults to `open`
- `--author @me` — issues created by current user
- `--milestone <title>` — issues in a milestone
- `--limit N` — max results (default varies; always set explicitly)

**Available JSON fields:** `assignees`, `author`, `body`, `closed`, `closedAt`, `comments`, `createdAt`, `id`, `isPinned`, `labels`, `milestone`, `number`, `projectItems`, `reactionGroups`, `state`, `stateReason`, `title`, `updatedAt`, `url`.

**Interpretation:**
- The result is always a JSON array. Empty array = no matching issues.
- **Note:** `state` is uppercase (`"OPEN"`/`"CLOSED"`) in `gh issue list`, unlike `gh search issues` where it is lowercase (`"open"`/`"closed"`). Normalize when comparing.
- `labels` is a `{name, color, description}` array like `gh search issues`.
- Use when the user wants structured filtering (by label, state, assignee) rather than free-text search.

---

## Backlog manipulation

### Reparenting

See the **Parent — set/unset** section under `issue-hierarchy` above. The pattern is:

```bash
# Move #5 under #10
/usr/local/libexec/adda-dev-runtime/bin/issue-hierarchy parent 5 --set 10

# Detach #5 from its parent (make it root-level)
/usr/local/libexec/adda-dev-runtime/bin/issue-hierarchy parent 5 --set NONE
```

**Before reparenting**, confirm with PO:
1. State the issue number and title being moved.
2. State the target parent number and title (fetch it first with `gh issue view <N> --json title` if not already known).
3. For detach: confirm they want to remove the parent relationship.

---

### Breaking down into sub-issues

Use when the user wants to decompose an epic or large issue into smaller sub-issues.

**Do not use `issue-hierarchy` directly for this.** Instead:

1. Invoke the `new-issue` skill for each sub-issue, with the epic/issue number specified as the parent (using `parent #N` phrasing so the skill picks it up via explicit-mention inference).
2. The `new-issue` skill handles: type selection, title/body inference, creation via `gh issue create`, and parent linking via `issue-hierarchy parent --set`.

Example conversational pattern:
> "Create a chore for adding input validation as a sub-issue of #348."
> "Also file a bug for the edge case when the input is empty, under the same parent."

Each sub-issue is created independently — there is no batch-create command.

If the user wants to break the *current active issue* into sub-issues, mention the active issue number explicitly so `new-issue`'s parent inference picks it up.

---

## General failure handling

- **`issue-hierarchy` failures:** Branch on `error.reason`:
  - `invalid_args` — the issue number or flag was wrong. Surface the error message; suggest the correct usage.
  - `shell_error` — the underlying `gh api` call failed. Check `details.stderr` for 404 (nonexistent issue) vs network/permissions error.
  - `validation_error` — the API returned unexpected data. This is an infrastructure issue — report to PO.
  - `internal_error` — write succeeded but verification failed. The change *may* have taken effect. Suggest manual verification.
- **`gh` command failures:** The exit code is non-zero and stderr contains the error. Surface it verbatim and stop. Do not retry silently.
- **Never roll back primary artifacts** on partial failure. An issue that was created but couldn't be linked to a parent is still a valid issue — report the partial outcome.
