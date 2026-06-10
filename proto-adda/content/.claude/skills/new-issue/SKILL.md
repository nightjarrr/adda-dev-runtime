---
name: new-issue
description: Create a new GitHub issue in the correct initial triage state for this project's agentic SDLC. Applies one type label (feature, bug, chore, or docs) plus phase: triage. Use this skill whenever the user wants to log, track, record, or capture something as a GitHub issue — even if they don't use the word "issue". Triggered by phrases like "create a new issue", "let's create an issue", "track this as an issue", "open an issue for this", "file a bug", "let's file an issue", "add chore issue", "submit a docs issue".
allowed-tools: Write(/tmp/*), Bash(gh issue create)
---

# New Issue (v2)

This skill creates a new GitHub issue in the initial state of the SDLC.

## Why this skill exists

Phase 1 (Triage) of the SDLC requires every issue to enter the system with:
- Exactly one **type label**: `feature`, `bug`, `chore`, or `docs`.
- The phase label `phase: triage`.

## Inputs

Three things are needed to create an issue:

1. **Type** — one of `feature`, `bug`, `chore`, `docs`. Their meanings:
   - `feature` — new functionality
   - `bug` — defect fix
   - `chore` — non-functional work (CI, dependencies, configuration, releases)
   - `docs` — documentation-only changes
2. **Title** — a single-line description in sentence case: first word capitalized, rest lowercase unless proper nouns.
3. **Body** (optional) — free-form markdown details.

## Flow

### Step 1 — Infer from context

Before asking anything, inspect the current conversation for information already available:
- If the type is evident (e.g. the user said "there's a bug" or "I want a new feature"), use it without asking.
- If the issue is sufficiently described in the conversation, infer a 3–8 word title and summarize the context into a dense, structured body.
- If nothing relevant can be inferred from the earlier conversation, start with all empty fields and go through the full Step 2 (starting from type selection).

### Step 2 — Fill gaps

Work through any missing pieces one at a time:

1. **Type unknown** — use `AskUserQuestion` with four options, one per type, each with its one-line description.
2. **Title unknown** — ask in plain text: "What should the issue title say?" and capture user input as the title value.

Ask one question at a time and wait for the answer before proceeding — multi-question flows feel like forms and users abandon them.

### Step 3 — Confirm

Always run this step, regardless of how the fields were gathered.

First, output the current field values as plain text:

```
Type:  <type>
Title: <title>
Body:  <body content, or "(empty)" if none>
```

Then call `AskUserQuestion`:
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

## Reporting back

Report to the user:
- Issue number (e.g. `#73`).
- Issue title.
- The two labels applied (the chosen type and `phase: triage`).
- Issue URL.

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

**Example 1 — type and title clear from conversational input:**

> "let's create a new feature issue to support AVIF input in the jpegify command"

Type (`feature`) and title inferred. Proceed to confirmation.

Output:
```
Type:  feature
Title: Support AVIF input in the jpegify command
Body:  (empty)
```

`AskUserQuestion`: "How would you like to proceed?" → "Create now", "Write body", "Revise"

> selects: "Create now"

```bash
gh issue create --title "Support AVIF input in the jpegify command" --body "" --label "feature" --label "phase: triage"
```
Reply: "Created #73 — Support AVIF input in the jpegify command — https://github.com/owner/repo/issues/73 — labels `feature` and `phase: triage`."

---

**Example 2 — type unclear, ask first:**

> "/new-issue-v2 rawtherapee times out on large RAW files"

Title inferred, type unclear. Use `AskUserQuestion` with 4 type choices.

> selects: `bug`

Output:
```
Type:  bug
Title: Rawtherapee times out on large RAW files
Body:  (empty)
```

`AskUserQuestion`: "How would you like to proceed?" → "Create now", "Write body", "Revise"

> selects: "Create now"

```bash
gh issue create --title "Rawtherapee times out on large RAW files" --body "" --label "bug" --label "phase: triage"
```
Reply: "Created #73 — Rawtherapee times out on large RAW files — https://github.com/owner/repo/issues/73 — labels `bug` and `phase: triage`."

---

**Example 3 — body inferred from multi-sentence input:**

> "We need to update pre-commit hook versions."
> "The repo is pinned to stable versions from 2024 and we should refresh to current."
> "Please file a chore task for this."

All fields inferred, title and body summarized from multiline description. Output:
```
Type:  chore
Title: Update pre-commit hook versions to latest stable
Body:  Currently the repo is using versions pinning, and version update was last done in 2024. Need to run a refresh to current stable versions.
```

`AskUserQuestion`: "How would you like to proceed?" → "Create now", "Write body", "Revise"

> selects: "Create now"

Write body to `/tmp/new-issue-body-3c9f14ab.md`, then:

```bash
gh issue create --title "Update pre-commit hook versions to latest stable" --body-file "/tmp/new-issue-body-3c9f14ab.md" --label "chore" --label "phase: triage"
```
Reply: "Created #73 — Update pre-commit hook versions to latest stable — https://github.com/owner/repo/issues/73 — labels `chore` and `phase: triage`."

---

**Example 4 — no arguments:**

> "/new-issue-v2"

Nothing to infer from. Use `AskUserQuestion` with 4 type choices.

> selects: `chore`

Ask in plain text: "What should the issue title say?"

> "Refresh pre-commit hook versions"

Output:
```
Type:  chore
Title: Refresh pre-commit hook versions
Body:  (empty)
```

`AskUserQuestion`: "How would you like to proceed?" → "Create now", "Write body", "Revise"

> selects: "Create now"

```bash
gh issue create --title "Refresh pre-commit hook versions" --body "" --label "chore" --label "phase: triage"
```
Reply: "Created #74 — Refresh pre-commit hook versions — https://github.com/owner/repo/issues/74 — labels `chore` and `phase: triage`."

---

**Example 5 — writing a body:**

Same as Example 4 up to confirmation. User selects "Write body":

Ask: "What should the body say?"

> "The repo is pinned to versions from 2024 and we should refresh to current."

Output:
```
Type:  chore
Title: Refresh pre-commit hook versions
Body:  The repo is pinned to versions from 2024 and we should refresh to current.
```

`AskUserQuestion`: "How would you like to proceed?" → "Create now", "Write body", "Revise"

> selects: "Create now"

Write body to `/tmp/new-issue-body-7e2d05f1.md`, then:

```bash
gh issue create --title "Refresh pre-commit hook versions" --body-file "/tmp/new-issue-body-7e2d05f1.md" --label "chore" --label "phase: triage"
```
Reply: "Created #74 — Refresh pre-commit hook versions — https://github.com/owner/repo/issues/74 — labels `chore` and `phase: triage`."

---

**Example 6 — model-triggered with context inference:**

Earlier in conversation: "the ffmpeg timeout on large files is really annoying, we should fix that"

> "track this as an issue"

Infer: type=`bug`, title="FFmpeg times out on large files". Output:
```
Type:  bug
Title: FFmpeg times out on large files
Body:  (empty)
```

`AskUserQuestion`: "How would you like to proceed?" → "Create now", "Write body", "Revise"

> selects: "Create now"

```bash
gh issue create --title "FFmpeg times out on large files" --body "" --label "bug" --label "phase: triage"
```
Reply: "Created #75 — FFmpeg times out on large files — https://github.com/owner/repo/issues/75 — labels `bug` and `phase: triage`."

---

**Example 7 — going back to revise:**

Same as Example 6 up to confirmation. User selects "Revise":

All fields discarded. Use `AskUserQuestion` with 4 type choices.

> selects: `feature`

Ask in plain text: "What should the issue title say?"

> "Add configurable timeout for FFmpeg commands"

Output:
```
Type:  feature
Title: Add configurable timeout for FFmpeg commands
Body:  (empty)
```

`AskUserQuestion`: "How would you like to proceed?" → "Create now", "Write body", "Revise"

> selects: "Create now"

```bash
gh issue create --title "Add configurable timeout for FFmpeg commands" --body "" --label "feature" --label "phase: triage"
```
Reply: "Created #74 — Add configurable timeout for FFmpeg commands — https://github.com/owner/repo/issues/74 — labels `feature` and `phase: triage`."
