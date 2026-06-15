---
name: quality-gates-required-for-direct-fixes
description: "When PM skips Coder dispatch and fixes directly in-session, local quality gates must run before push"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: fbce4374-fdfc-4981-990c-a1defb12cbf2
---

When PM decides to handle a code fix directly in-session rather than dispatch Coder (e.g. for trivial formatting or param changes), PM is still required to run the full local quality gate suite (tests, typecheck, lint, format) **before** committing and pushing. Skipping this step is unacceptable — it wastes CI time and shifts verification left that should have been caught locally.

**Why:** The Coder dispatch normally runs quality gates as part of its workflow. When PM bypasses Coder, the responsibility for running those gates shifts to PM. Pushing without verifying shifts the verification burden to CI, which is slower and wastes resources.

**How to apply:** Before any `git push` on a direct fix, run `quality-gates` (the dedicated script at `/usr/local/libexec/adda-dev-runtime/bin/quality-gates`) — it runs the full suite (tests, builds, typecheck, lint, format, bun-version) in one invocation.
