---
description: >
  Load this skill before using any CLI tool that is not already documented in
  the current context — especially on first use in a session. Do not wait until
  you are uncertain: load it proactively. Common cases where loading prevents
  errors: reaching for grep (use rg instead), find (use fdfind), python or node
  (not installed — use bun), docker (not accessible in this container), npm or
  pip (use bun). The skill renders a live table of registered tools with their
  canonical usage patterns and identifies constrained or absent tools so you pick
  the right alternative immediately. When in doubt, load it — undertriggering
  wastes more effort than loading it unnecessarily.
user-invocable: false
---

!`/usr/local/libexec/adda-dev-runtime/bin/render-adda-shell-tools`
