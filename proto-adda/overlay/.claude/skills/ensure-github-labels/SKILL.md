---
name: ensure-github-labels
description: Ensures all GitHub labels required by SDLC exist on the current repo. Creates any missing labels with correct descriptions; skips labels that already exist. Only first 200 existing labels are inspected.
disable-model-invocation: true
context: fork
model: Haiku
allowed-tools: Bash(gh label *) Bash(jq)
---

# ensure-github-labels

Ensure all labels required by SDLC exist on the current GitHub repo. Create missing ones; skip existing ones.
**This skill is only modifying GitHub labels, not the files. It does NOT create or modify any files.**

## Required labels

| label | description |
|---|---|
| `feature` | New functionality |
| `bug` | Defect fixes |
| `chore` | Non-functional work: CI, dependencies, configuration, releases |
| `docs` | Documentation-only changes |
| `phase: triage` | Newly created, awaiting triage by Project Owner or in process of triage |
| `phase: spec` | Spec in progress or awaiting acceptance |
| `phase: tech-design` | Tech design in progress or awaiting acceptance |
| `phase: impl-plan` | Implementation plan in progress or awaiting acceptance |
| `phase: impl-coding` | Coding in progress; ends with code committed, pushed, and CI green on feature branch |
| `phase: impl-docs` | Documentation update in progress; ends with docs committed, pushed, and CI green on feature branch |
| `phase: impl-done` | Implementation and documentation complete, PR ready to be opened or open |
| `phase: merged` | Merged to main, pending release |
| `phase: released` | Included in a published release |

## Steps

1. Fetch existing labels from the repo:
   ```bash
   gh label list --limit 200 --json name | jq -r '.[].name'
   ```

2. Returned output is the plain text list of existing label names, one label name per line.

3. For each label in the required table above, check if it already exists (case-sensitive match).

4. For each **missing** label, attempt to create it, using the row from the table:
   ```bash
   gh label create "<name>" --description "<description>"
   ```
   If the command fails for any reason (e.g. there's an underlying API error, or the label was created concurrently, or already exists despite not appearing in the list), do not abort the whole operation, record a warning for that label and continue with the rest.

5. Report results: list which labels were **created**, which were **already present** (skipped), and any **warnings** from failed create attempts.

## Output format

Print a summary like:

```
Created:
  ✓ phase: triage
  ✓ phase: spec

Already existing (skipped):
  • feature
  • bug

Warnings:
  ⚠ phase: impl-plan: not created (API error: <error text>)
  ⚠ chore: not created (already exists)

```

If all labels already exist, say so and confirm no changes were made. Warnings are informational; the skill succeeds when it makes a best-effort attempt to create all missing labels and reports the results.
