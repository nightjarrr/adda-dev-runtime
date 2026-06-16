---
name: new-issue
description: Create a new GitHub issue in the correct initial triage state for this project's agentic SDLC. Applies one type label (feature, bug, chore, or docs) plus phase: triage. Use this skill whenever the user wants to log, track, record, or capture something as a GitHub issue — even if they don't use the word "issue". Triggered by phrases like "create a new issue", "let's create an issue", "track this as an issue", "open an issue for this", "file a bug", "let's file an issue", "add chore issue", "submit a docs issue".
allowed-tools: Write(/tmp/*), Bash(gh issue create), Bash(gh issue view *), Bash(/usr/local/libexec/adda-dev-runtime/bin/current-issue *), Bash(/usr/local/libexec/adda-dev-runtime/bin/issue-hierarchy *)
---

# New Issue (v2)

This skill creates a new GitHub issue in the initial state of the SDLC.

## Why this skill exists

Phase 1 (Triage) of the SDLC requires every issue to enter the system with:
- Exactly one **type label**: `feature`, `bug`, `chore`, or `docs`.
- The phase label `phase: triage`.

## Inputs

Four things are needed to create an issue:

1. **Type** — one of `feature`, `bug`, `chore`, `docs`. Their meanings:
   - `feature` — new functionality
   - `bug` — defect fix
   - `chore` — non-functional work (CI, dependencies, configuration, releases)
   - `docs` — documentation-only changes
2. **Title** — a single-line description in sentence case: first word capitalized, rest lowercase unless proper nouns.
3. **Body** (optional) — free-form markdown details.
4. **Parent** (optional) — the issue number of the parent issue. Leave empty/unset to create a root-level issue with no parent.

## Flow

### Step 1 — Infer from context

Before asking anything, inspect the current conversation for information already available:
- If the type is evident (e.g. the user said "there's a bug" or "I want a new feature"), use it without asking.
- If the issue is sufficiently described in the conversation, infer a 3–8 word title and summarize the context into a dense, structured body.
- If nothing relevant can be inferred from the earlier conversation, start with all empty fields and go through the full Step 2 (starting from type selection).

**Parent inference**, performed in order:

1. **Explicit mention in conversation.** If the user says "as a child of #N", "parent #N", "sub-issue of #N", "under #N", or similar, extract N as the parent number. No need to validate existence at this point — Step 3 will validate it.

2. **Current-issue breakdown scenario.** If the user says "break this into sub-issues", "create subtasks for", "sub-issues for the current issue", or similar, run `current-issue show` to detect the active issue as a candidate parent:

   ```bash
   /usr/local/libexec/adda-dev-runtime/bin/current-issue show
   ```

   The command emits a JSON envelope. On success (`status: "ok"`), the `result.issue` object carries the issue id, title, and other fields. For this skill, only the id and title are relevant:

   ```json
   {
     "status": "ok",
     "result": {
       "issue": {
         "id": "273",
         "title": "Allow new-issue skill to set parent issue",
         ...
       }
     },
     "error": null
   }
   ```

   - If `status` is `"ok"` and `result.issue` is non-null, the active issue exists. Propose it as the parent to the user:
     > "The current active issue is #273 — Allow new-issue skill to set parent issue. Should this new issue be a child of it?"
     - **User confirms** → set parent to the current issue.
     - **User declines** → ask if they want to specify a different parent number, or proceed without one. If they give a number, use that. Otherwise, parent stays unset.
   - If `status` is `"fail"` or `result.issue` is null, there is no active issue context. Fall through — parent stays unset.

3. **Otherwise.** Parent stays unset. No auto-inference from current-issue in the general case — most created issues are root-level.

### Step 2 — Fill gaps

Work through any missing pieces one at a time:

1. **Type unknown** — use `AskUserQuestion` with four options, one per type, each with its one-line description.
2. **Title unknown** — ask in plain text: "What should the issue title say?" and capture user input as the title value.

Ask one question at a time and wait for the answer before proceeding — multi-question flows feel like forms and users abandon them.

### Step 3 — Confirm

Always run this step, regardless of how the fields were gathered.

**Before displaying the confirmation block**, if parent was inferred in Step 1, resolve its title:

- **From current-issue breakdown:** The title was already returned in the `current-issue show` result. Use it directly.
- **From explicit mention (`"child of #N"`):** Fetch the title:

  ```bash
  gh issue view <N> --json title
  ```

  **Result interpretation:**
  - On success, stdout contains `{ "title": "..." }`. Extract and display the title.
  - On failure (exit non-zero), the parent does not exist or is inaccessible. Report the error and clear the parent field before showing the confirmation block.

**Then display the confirmation block** with the current field values:

```
Type:   <type>
Title:  <title>
Body:   <body content, or "(empty)" if none>
Parent: <#N — parent issue title, or "(none)" if no parent>
```

**Then call `AskUserQuestion`**:
- Question: "How would you like to proceed?"
- Options:
  - "Create now" — create the issue with the fields shown above.
  - "Write body" — ask in plain text: "What should the body say?" (replaces any existing body), then repeat this confirmation step.
  - "Revise" — discard all fields and restart from Step 2 (type selection).

### Step 4 — Create

**If body is empty**, pass it inline:

```bash
gh issue create \
  --title "<title>" \
  --body "" \
  --label "<type>" \
  --label "phase: triage"
```

**If body is non-empty**, write it to a temp file first using the Write tool (path: `/tmp/new-issue-body-<uuid>.md`, where `<uuid>` is a random 8-character hex string you generate), then reference it with `--body-file`:

```bash
gh issue create \
  --title "<title>" \
  --body-file "/tmp/new-issue-body-<uuid>.md" \
  --label "<type>" \
  --label "phase: triage"
```

Both labels go in the same call as separate `--label "<value>"` switches.

`gh issue create` prints the URL of the created issue on success. Parse the issue number from the trailing path segment (e.g. `https://github.com/owner/repo/issues/73` → `#73`).

**If a parent is set**, after the issue is created and its number is parsed, link them:

```bash
/usr/local/libexec/adda-dev-runtime/bin/issue-hierarchy parent <new-number> --set <parent-number>
```

The command emits a JSON envelope:

Success:
```json
{
  "status": "ok",
  "result": {
    "issue": 401,
    "parent": {
      "number": 340,
      "title": "Issue hierarchy view improvements"
    }
  },
  "error": null
}
```

Failure:
```json
{
  "status": "fail",
  "result": null,
  "error": {
    "reason": "shell_error",
    "message": "shell command failed",
    "details": {}
  }
}
```

**Result interpretation:**
- If `status` is `"ok"`, the parent link was created successfully. Proceed to reporting.
- If `status` is `"fail"` or the command exits non-zero, the issue was created but could not be linked. Check `error.reason` to differentiate:
  - **`shell_error` with a 404 in the API response** → the parent issue does not exist. Tell the user the parent number may be wrong.
  - **`shell_error` with other exit codes** → the API call failed (network, permissions, etc.). Suggest retrying.
  - **`internal_error`** → verification after linking failed. The link may or may not have taken effect. Suggest checking manually.
  
  In all cases, report clearly:

  > "Issue #N was created but could not be attached to parent #{parent}. {error.message}. Use `issue-hierarchy parent #{N} --set {parent}` to retry."

  Do **not** attempt to roll back — the issue itself is the primary artifact.

## Reporting back

Report to the user:
- Issue number (e.g. `#73`).
- Issue title.
- The two labels applied (the chosen type and `phase: triage`).
- Issue URL.

If parent is set, include `child of #{parent}` in the reply:

> "Created #N — {title} — child of #{parent} — {url} — labels `{type}` and `phase: triage`."

If no parent, the reply is unchanged from the existing pattern.

This is the final step. Do **not**:
- Drive triage.
- Create a branch or any spec/design/plan files.
- Open a PR.
- Call other skills.

## Failure handling

Surface failures clearly and stop. Do not paper over them or retry silently — these are usually configuration issues the user needs to fix, and silent retries can produce duplicate issues.

- **Missing labels.** If `gh issue create` fails because a required label doesn't exist, report which label is missing and stop. Suggest using the `ensure-github-labels` skill if it is available.
- **`gh` unauthenticated or wrong repo.** Report the verbatim error and stop.
- **API failure.** Report the error and stop.

## Examples

The examples below illustrate the main flows. All produce the same `AskUserQuestion` at confirmation ("Create now", "Write body", "Revise") — only the inference, creation, and reply details vary.

| Scenario | Type | Title | Body | Parent |
|---|---|---|---|---|
| "file a bug" | bug | inferred | — | — |
| "create a chore to X as child of #N" | chore | inferred | inferred | #N |
| "break this into sub-issues" | inferred | inferred | — | current issue |
| "/new-issue-v2" (bare) | ask | ask | — | — |
| User selects "Write body" | as set | as set | written | as set |
| User selects "Revise" | discarded | discarded | discarded | discarded |

**Example 1 — all fields inferred, body written to file:**

> "We need to update pre-commit hook versions."
> "The repo is pinned to stable versions from 2024 and we should refresh to current."
> "Please file a chore task for this."

All fields inferred, title and body summarized. Confirmation:
```
Type:   chore
Title:  Update pre-commit hook versions to latest stable
Body:   Currently the repo is using versions pinning, and version update was last done in 2024. Need to run a refresh to current stable versions.
Parent: (none)
```

User selects "Create now". Write body to `/tmp/new-issue-body-3c9f14ab.md`, then:
```bash
gh issue create --title "Update pre-commit hook versions to latest stable" --body-file "/tmp/new-issue-body-3c9f14ab.md" --label "chore" --label "phase: triage"
```
Reply: "Created #73 — Update pre-commit hook versions to latest stable — https://github.com/owner/repo/issues/73 — labels `chore` and `phase: triage`."

---

**Example 2 — type and title asked, body empty:**

> "/new-issue-v2"

Nothing to infer. Ask type (selects: `bug`), ask title ("Rawtherapee times out on large RAW files"). Confirmation:
```
Type:   bug
Title:  Rawtherapee times out on large RAW files
Body:   (empty)
Parent: (none)
```

User selects "Create now":
```bash
gh issue create --title "Rawtherapee times out on large RAW files" --body "" --label "bug" --label "phase: triage"
```
Reply: "Created #74 — Rawtherapee times out on large RAW files — https://github.com/owner/repo/issues/74 — labels `bug` and `phase: triage`."

---

**Example 3 — explicit parent from conversation:**

> "create a chore for updating README as a child of #340"

Step 1 infers type=`chore`, title="Update the README", parent=`340`. Step 3 fetches the parent title via `gh issue view 340 --json title`. Confirmation:
```
Type:   chore
Title:  Update the README
Body:   (empty)
Parent: #340 — Issue hierarchy view improvements
```

User selects "Create now":
```bash
gh issue create --title "Update the README" --body "" --label "chore" --label "phase: triage"
```
Parse the issue number from the URL (e.g. `#401`). Then:
```bash
/usr/local/libexec/adda-dev-runtime/bin/issue-hierarchy parent 401 --set 340
```
Reply: "Created #401 — Update the README — child of #340 — https://github.com/owner/repo/issues/401 — labels `chore` and `phase: triage`."

---

**Example 4 — inferred parent via current-issue breakdown:**

> "break this into sub-issues" (while working on #273)

Step 1 detects breakdown intent, runs `current-issue show`, finds #273, proposes it. User confirms. Title asked ("Update README"). Confirmation:
```
Type:   chore
Title:  Update README
Body:   (empty)
Parent: #273 — Allow new-issue skill to set parent issue
```

User selects "Create now":
```bash
gh issue create --title "Update README" --body "" --label "chore" --label "phase: triage"
```
Parse the issue number from the URL (e.g. `#402`). Then:
```bash
/usr/local/libexec/adda-dev-runtime/bin/issue-hierarchy parent 402 --set 273
```
Reply: "Created #402 — Update README — child of #273 — https://github.com/owner/repo/issues/402 — labels `chore` and `phase: triage`."
