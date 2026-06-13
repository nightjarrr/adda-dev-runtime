---
name: feedback_design_pattern_breadth
description: "When facing a design problem, consider the full space of known patterns — not just reshuffling within self-imposed confines"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 31d211c0-ff75-4561-af33-a1581d4fed74
---

When a design problem arises (e.g. "how do I pass optional named params to a constructor?"), avoid iterating only within a narrow solution space. Step back and consider the full range of established patterns: Builder, fluent setters after construction, factory methods, named constructors, static helpers, etc.

**Why:** PO observed that I was reshuffling positional args vs opts objects without ever considering patterns like Builder or property setting — solutions that may be more natural fits.

**How to apply:** When stuck on a design question that seems to have no clean answer within the current approach, that's a signal to zoom out and ask "what known pattern solves this class of problem?" before continuing to iterate on variations of the same approach.
