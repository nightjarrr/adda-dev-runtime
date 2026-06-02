---
description: >
  Always load this skill the first time you reach for any CLI tool in a session —
  this container is a specialized runtime where common assumptions about available
  tooling are often wrong. Reaching for grep, find, python, node, pip, npm, docker,
  or sudo without checking first leads to errors, wasted calls, and failed operations.
  The skill renders a live table of what is actually installed (use rg not grep,
  fdfind not find, bun not python/node) and explicitly warns about tools that are
  blocked by the container environment.
user-invocable: false
---

!`/usr/local/libexec/adda-dev-runtime/bin/render-adda-shell-tools`
