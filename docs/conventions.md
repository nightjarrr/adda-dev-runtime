# Conventions

## Bash

- Open with `set -euo pipefail`.
- `# shellcheck disable=SC…` requires a `# Why:` comment on the immediately following line.
- The `section`/`die`/`warning`/`success` helpers are defined in `entrypoint.sh` and
  available only in sourced entrypoint hooks (`entrypoint.d/*.sh`); not in standalone scripts.

## .sh.source files

Scripts baked via proto-adda Dockerfile live under `proto-adda/overlay/scripts/` with a
`.sh.source` extension. The Dockerfile strips `.source` on COPY to
`/usr/local/libexec/adda-dev-runtime/`. Apply all bash conventions above.

## Dockerfiles

- First line: `# syntax=docker/dockerfile:1.7`.
- All `RUN` steps must pass `hadolint` (enforced in CI `base.yml`).
