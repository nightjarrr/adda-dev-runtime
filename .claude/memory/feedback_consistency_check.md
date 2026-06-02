---
name: Consistency check after plan edits
description: After changing a fact in one place in a plan or document, scan all other occurrences before saving
type: feedback
originSessionId: 02f04649-8032-48d9-ace2-5c473415b2f7
---
After introducing a change to a plan (or any document), do a full consistency pass over the entire scope before finalising — search for all other references to the thing being changed and update them too.

**Why:** A targeted edit to one section left a contradictory remnant in another section of the same plan (homedir() removed in point 2 but kept in point 10). PO had to catch it.

**How to apply:** After any edit that changes a name, value, approach, or decision, grep or read the full document to confirm no other occurrence contradicts the change before calling ExitPlanMode or handing off to Coder.
