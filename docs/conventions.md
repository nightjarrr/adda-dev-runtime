# Conventions

## Bash

- Open with `#!/bin/bash` and `set -euo pipefail`.
- Begin each script with a brief comment block stating purpose, inputs, and outputs (and sourcing
  context if the script is sourced rather than executed).
- Structure logic into named functions; group related functions under `# ---`-delimited section
  headings.
- `# shellcheck disable=SC…` requires a `# Why:` comment on the immediately following line.
- The `section`/`die`/`warning`/`success` helpers are defined in `entrypoint.sh` and available
  only in sourced entrypoint hooks (`entrypoint.d/*.sh`); not in standalone scripts.

## .sh.source files

Scripts baked to `/usr/local/libexec/adda-dev-runtime/` carry a `.sh.source` extension in
the repo and no exec bit. The Dockerfile `RUN` step renames them (strips `.source`) and
sets the exec bit with `chmod`. This convention applies to all scripts baked to that path
regardless of tier:

- Tier 1 scripts live under `adda-dev-runtime/content/scripts/`.
- Tier 2 scripts live under `proto-adda/content/entrypoint.d/`.

Apply all bash conventions above.

## Dockerfiles

- First line: `# syntax=docker/dockerfile:1.7`.
- `# hadolint ignore=<rule>` requires a `# Why:` comment on the immediately preceding line
  (hadolint suppression must be the line immediately before the `RUN` instruction).
- All `RUN` steps must pass `hadolint` (enforced in CI `base.yml`).
