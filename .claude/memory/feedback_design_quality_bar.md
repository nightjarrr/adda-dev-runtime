---
name: feedback-design-quality-bar
description: "PO reviews code at a high design bar and iterates until it is genuinely well-designed, not just functional"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: c754e9d9-0c22-4461-a584-6f37c6013051
---

PO holds code to a high clean-design bar and will run multiple review→delta rounds until the design is genuinely good, not merely passing tests. On the `pr-review-threads` work (#265) they rejected a mechanical file-split decomposition ("badly designed but functional"), demanded OO/clean-code principles, replaced substring-matching error classification with a typed error carrying its own `reason`, insisted "dead code is never okay," and preferred reusing a built-in abstraction (`ConfigError`) over re-inventing one (`PrThreadsError("invalid_config")`).

**Why:** shipping functional-but-mediocre code triggers several extra review rounds — the PO reviews at the diff level and catches design smells precisely (duplication, dead code, string-typing in a typed language, over/under-abstraction, leaky contracts).

**How to apply:** invest in real design up front — typed abstractions over string-matching, no dead code, reuse existing library abstractions, DRY without over-unification, tight output contracts (structured envelope on stdout; stderr for diagnostics only). Discuss design direction before implementing anything non-trivial, and treat the first Coder pass as a starting point that will face thorough review. Relates to [[feedback-consistency-check]].
