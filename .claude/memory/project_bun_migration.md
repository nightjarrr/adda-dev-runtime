---
name: Bun migration and release plan
description: Issue 107 — migrate from Node.js to Bun; a new release must be cut after the migration is done
type: project
originSessionId: 84575678-3214-4965-8b5a-c4f449506955
---
Issue 107: Install Bun in Tier 1, remove Node.js from Tier 2, switch Claude Code to `bun install -g`.

After this migration is merged, PO wants to cut a new release.

**Why:** Part of umbrella #106; Bun replaces Node.js as the JS runtime for Claude Code.
**How to apply:** After PR is merged and main CI is green, prompt PO about cutting the release.
