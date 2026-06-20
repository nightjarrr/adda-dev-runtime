---
name: new-issue
description: Create a new GitHub issue in the correct initial triage state for this project's agentic SDLC. Applies one type label (feature, bug, chore, or docs) plus phase: triage. Always use this skill whenever the user wants to log, track, or capture any task, bug report, feature request, or documentation need — even casual mentions like "file a bug", "track this", "open an issue", "let's create an issue", "add a chore", or "submit a docs issue". When in doubt about whether something should be tracked as an issue, this is the right skill. Also trigger when the user talks about something that sounds like it needs a GitHub issue, even if they don't say "issue" explicitly.
allowed-tools: Write(/tmp/*), Bash(gh issue create), Bash(gh issue view *), Bash(/usr/local/libexec/adda-dev-runtime/bin/current-issue *), Bash(/usr/local/libexec/adda-dev-runtime/bin/issue-hierarchy *)
---

# New Issue (v3)

This skill creates a new GitHub issue in the initial state of the SDLC.

## Why this skill exists

Phase 1 (Triage) of the SDLC requires every issue to enter the system with:
- Exactly one **type label**: `feature`, `bug`, `chore`, or `docs`.
- The phase label `phase: triage`.

## Inputs

Four things are produced to create an issue:

1. **Type** — one of `feature`, `bug`, `chore`, `docs`. Their meanings:
   - `feature` — new functionality
   - `bug` — defect fix
   - `chore` — non-functional work (CI, dependencies, configuration, releases)
   - `docs` — documentation-only changes
2. **Title** — a single-line description in sentence case: first word capitalized, rest lowercase unless proper nouns. 3–8 words, summarizing the user's intent. To derive the title from conversation, extract the core action and subject: use a {verb} {noun phrase} pattern — e.g., "Fix login redirect timeout" or "Add input validation to signup form". Avoid generic titles like "Bug fix" or "New feature" that don't distinguish the issue.
3. **Body** — free-form markdown details, always populated from conversational context as a structured summary.
4. **Parent** (optional) — the issue number of the parent issue. Leave empty/unset to create a root-level issue with no parent.

## Flow

### Phase 1 — Understand the context

**Ask about the substance, not the fields.** Your goal is to understand what the user wants to achieve — not to populate the issue form. Field-filling questions ("What type of issue is this?", "What should the title say?") feel like forms and lose the context you've already built. Substance questions ("What's going wrong?", "What would you like to happen?") feel like collaboration — they reveal the information you need as a natural byproduct of understanding the task.

**Start with what's already available.** Inspect the current conversation for context. If the type and title can already be clearly inferred from what was discussed, proceed directly to Phase 2.

**Gather context naturally.** If the type and title are not yet clearly inferable, ask about the substance:
- What's the problem or desired outcome?
- What's affected?
- What would a resolution look like?

Ask one question at a time and wait for the answer — multi-question flows feel like forms and users abandon them.

**Last resort — clarify the type.** If after 2–3 attempts to understand the substance the type is still unclear, ask as a final structured clarification:

> "Is this about new functionality, a defect in existing functionality, a maintenance task, or a documentation update?"

Present these as a single `AskUserQuestion` with `header`: "Issue type", `question`: "What type of issue is this?", and one option per type, each with its one-line description (matching the Inputs section above). The user's selection resolves the type directly. If type is now determined but the title remains unclear, return to context-gathering conversation — do not ask for a title directly.

**Proceed only when ready.** You need at least type and title to be clearly inferable before moving on. Do not proceed if either is still ambiguous.

After 3 rounds of context-gathering without reaching clarity on both type and title, present your best inference — even if partial — with a clear note about what remained uncertain. The user can correct anything at confirmation.

**Parent inference**, performed as part of context-gathering:

1. **Explicit mention in conversation.** If the user says "as a child of #N", "parent #N", "sub-issue of #N", "under #N", or similar, extract N as the parent number. No need to validate existence at this point — Phase 2 will validate it.

2. **Current-issue breakdown scenario.** If the user says "break this into sub-issues", "create subtasks for", "sub-issues for the current issue", or similar, run `current-issue show` to detect the active issue as a candidate parent:

   ```bash
   /usr/local/libexec/adda-dev-runtime/bin/current-issue show
   ```

   The command emits a JSON envelope. On success (`status: "ok"`), the `result.issue` object carries the scalar issue fields (id, title, type, phase, pr, owner, repo). Hierarchy fields (parent, children, siblings) are not included in the default output — they are not needed here. For this skill, only the id and title are relevant:

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

### Phase 2 — Propose and confirm

Always present your inferred values to the user before creating. Do not skip this step.

**Before presenting**, if parent was set in Phase 1, resolve its title:

- **From current-issue breakdown:** The title was already returned in the `current-issue show` result. Use it directly.
- **From explicit mention (`"child of #N"`):** Fetch the title:

  ```bash
  gh issue view <N> --json title
  ```

  **Result interpretation:**
  - On success, stdout contains `{ "title": "..." }`. Extract and display the title.
  - On failure (exit non-zero), the parent does not exist or is inaccessible. Tell the user: "Parent #{N} could not be resolved — it may not exist or may be inaccessible. Proceeding without a parent link." Clear the parent field before showing the confirmation block.

**Display the confirmation block** with all inferred fields. Body should always have content at this point. If it ended up very brief (1–2 words), append "(from context)" so the user knows they can expand it via the free-text override.

```
Type:   <type>
Title:  <title>
Body:   <body content>
Parent: <#N — parent issue title, or "(none)" if no parent>
```

**Then call `AskUserQuestion`** with:
- `header`: "New issue"
- `question`: "Create this issue?"
- Two options:
  - "Yes, create it" — create the issue with the fields shown above.
  - "No, let me adjust" — provide feedback to correct the inferred values.

If the user selects "Yes, create it", proceed to Phase 3. If the user types custom input (the free-text "Other" option), interpret it as feedback on the proposed values — they may want to correct the title, add body detail, or change the type. Update the relevant field(s) based on their input, then loop back to re-display the confirmation block. If the correction is ambiguous, ask a clarifying question rather than guessing.

After 3 correction rounds, create the issue with whatever values you have rather than continuing to iterate — the user can always edit the issue after creation.

There is no "Write body" or "Revise" path — the body is always inferred and always populated. Corrections happen through the free-text override.

### Phase 3 — Create

The body should almost always be non-empty at this point — Phase 1 and Phase 2 ensure it is populated from context. The empty-body branch below is a safety net; if it fires, it means inference produced nothing, which is itself a signal that Phase 1 context-gathering could be tighter.

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

The examples below illustrate the main flows. All use the same three-phase structure (context → propose → create) with the same yes/no confirmation. Only the inference details and creation commands vary.

| Scenario | Context | Type | Title | Body | Parent |
|---|---|---|---|---|---|
| "file a bug about login timeout" | Clear from statement | bug | inferred | inferred | — |
| "create a chore to update pre-commit hooks as child of #N" | Clear from statement | chore | inferred | inferred | #N (explicit) |
| "break this into sub-issues" on active issue | Clarifying conversation | inferred | inferred | inferred | Current issue |
| Vague request, no prior context | Context-gathering conversation | last-resort ask | inferred | inferred | — |

**Example 1 — all fields inferred from a clear statement:**

> "We need to update pre-commit hook versions."
> "The repo is pinned to stable versions from 2024 and we should refresh to current."
> "Please file a chore task for this."

The statement is clear: type is `chore`, title and body are inferable. Proceed directly to Phase 2.

Confirmation:
```
Type:   chore
Title:  Update pre-commit hook versions to latest stable
Body:   Currently the repo is using versions pinning, and version update was last done in 2024. Need to run a refresh to current stable versions.
Parent: (none)
```

User selects "Yes, create it". Write body to `/tmp/new-issue-body-3c9f14ab.md`, then:
```bash
gh issue create --title "Update pre-commit hook versions to latest stable" --body-file "/tmp/new-issue-body-3c9f14ab.md" --label "chore" --label "phase: triage"
```
Reply: "Created #73 — Update pre-commit hook versions to latest stable — https://github.com/owner/repo/issues/73 — labels `chore` and `phase: triage`."

---

**Example 2 — ambiguous request resolved through conversation:**

> "/new-issue"

No prior context. Phase 1 begins: "Sure! What would you like to create an issue about?" User says "There's a bug in the image upload dialog — it crashes when I select a RAW file." Type and title are now clear.

Confirmation:
```
Type:   bug
Title:  Image upload dialog crashes on RAW file selection
Body:   The image upload dialog crashes when selecting a RAW file. No error handling around file format validation.
Parent: (none)
```

User selects "Yes, create it":
```bash
gh issue create --title "Image upload dialog crashes on RAW file selection" --body "The image upload dialog crashes when selecting a RAW file. No error handling around file format validation." --label "bug" --label "phase: triage"
```
Reply: "Created #74 — Image upload dialog crashes on RAW file selection — https://github.com/owner/repo/issues/74 — labels `bug` and `phase: triage`."

---

**Example 3 — user provides correction via free-text at confirmation:**

> "We should add input validation to the signup form. File a chore for that."

This is clear enough: type `chore`, title and body inferable. Confirmation:
```
Type:   chore
Title:  Add input validation to signup form
Body:   Need to implement input validation for the signup form fields.
Parent: (none)
```

User types in "Other": "Actually this is a feature, and the title should be 'Add client-side validation to signup form' and mention the specific fields in the body."

Update the inferred values and re-display:
```
Type:   feature
Title:  Add client-side validation to signup form
Body:   Need to implement client-side input validation for the signup form fields. Should cover email, password strength, and username format validation.
Parent: (none)
```

User selects "Yes, create it":
```bash
gh issue create --title "Add client-side validation to signup form" --body-file "/tmp/new-issue-body-a1b2c3d4.md" --label "feature" --label "phase: triage"
```

---

**Example 4 — explicit parent from conversation:**

> "create a chore for updating README as a child of #340"

This is clear: type=`chore`, title="Update the README", parent=`340`. Phase 2 fetches the parent title via `gh issue view 340 --json title`. Confirmation:
```
Type:   chore
Title:  Update the README
Body:   Task to update the project README with latest changes.
Parent: #340 — Issue hierarchy view improvements
```

User selects "Yes, create it":
```bash
gh issue create --title "Update the README" --body "Task to update the project README with latest changes." --label "chore" --label "phase: triage"
```
Parse the issue number from the URL (e.g. `#401`). Then:
```bash
/usr/local/libexec/adda-dev-runtime/bin/issue-hierarchy parent 401 --set 340
```
Reply: "Created #401 — Update the README — child of #340 — https://github.com/owner/repo/issues/401 — labels `chore` and `phase: triage`."

---

**Example 5 — inferred parent via current-issue breakdown:**

> "break this into sub-issues" (while working on #273)

Phase 1 detects breakdown intent, runs `current-issue show`, finds #273, proposes it. User confirms. Phase 1 then gathers context: "What sub-issue would you like to create?" User says "We should split the big parser issue into smaller tasks."

Confirmation:
```
Type:   chore
Title:  Split parser module into focused components
Body:   The parser module has grown too large. Break it down into focused components for better maintainability.
Parent: #273 — Allow new-issue skill to set parent issue
```

User selects "Yes, create it":
```bash
gh issue create --title "Split parser module into focused components" --body "The parser module has grown too large. Break it down into focused components for better maintainability." --label "chore" --label "phase: triage"
```
Parse the issue number from the URL (e.g. `#402`). Then:
```bash
/usr/local/libexec/adda-dev-runtime/bin/issue-hierarchy parent 402 --set 273
```
Reply: "Created #402 — Split parser module into focused components — child of #273 — https://github.com/owner/repo/issues/402 — labels `chore` and `phase: triage`."
