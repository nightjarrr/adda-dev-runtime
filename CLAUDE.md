# ADDA Dev Runtime

This repo *is* the dev runtime. Design and current state are in
`docs/adda-dev-runtime.md` and `docs/adda-dev-runtime-current-state.md`.

## Repo layout

- `docker/adda-dev-runtime/` — Tier 1 base image (Dockerfile, entrypoint.sh).
- `proto-adda/` — Tier 2 AI-harness image. Ships an overlay
  (`proto-adda/overlay/`) that the Tier 1 entrypoint applies to `~/.claude/`
  at container start.
- `launcher/adda-dev.sh` — host-side launcher.
- `docker/envoy/` — Envoy proxy template.

## Working on the runtime from inside the runtime

The Claude Code session that develops this repo runs in a proto-adda
container built from this same repo. Two consequences:

- **No Docker in the container.** Image builds and launch tests are run by
  PO on the host, not by the agent. Verification inside the container is
  limited to file/path checks and `quality-gates.sh`.
- **Read-only root filesystem.** Runtime artifacts baked into the image
  cannot be modified in the running container. Edits to source files in
  this repo (Tier 1 entrypoint, proto-adda hooks, overlay) affect future
  image builds only.
