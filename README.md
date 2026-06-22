# adda-dev-runtime

[![GitHub Release](https://img.shields.io/github/v/release/nightjarrr/adda-dev-runtime)](https://github.com/nightjarrr/adda-dev-runtime/releases/latest)
[![CI](https://github.com/nightjarrr/adda-dev-runtime/actions/workflows/ci.yml/badge.svg)](https://github.com/nightjarrr/adda-dev-runtime/actions/workflows/ci.yml)
[![Release](https://github.com/nightjarrr/adda-dev-runtime/actions/workflows/release.yml/badge.svg)](https://github.com/nightjarrr/adda-dev-runtime/actions/workflows/release.yml)

[ADDA SDLC](https://github.com/nightjarrr/molim/blob/main/docs/adda-sdlc.md) is a structured agentic framework: an AI coding agent works inside a hardened, ephemeral container and persists all development state through GitHub.

---

## What it is

ADDA runs an AI coding agent inside an isolated, ephemeral container. The agent operates with no persistent local state — all work is committed and pushed to GitHub. Network access is enforced by a per-session Envoy proxy sidecar on the host, with a default-deny domain allow-list.

The runtime is a tier stack:

- **Tier 1 (`adda-dev-runtime`)** — generic, AI-tool-agnostic base image. Provides the hardened container infrastructure: entrypoint, proxy bridge, system tools, and Bun scripting runtime.
- **Tier 2 (`proto-adda`)** — AI harness layer. Builds `FROM` Tier 1, adds Claude Code, and delivers the SDLC configuration.
- **Tier 3** — the project being developed. A standard GitHub repo that uses the runtime as its development environment.

This repository ships Tier 1 and proto-adda (Tier 2 for Claude Code). See [`docs/adda-dev-runtime-design.md`](docs/adda-dev-runtime-design.md) for the full conceptual design.

---

## Running ADDA Dev Runtime

To launch a session on the host, use the [adda-dev-launcher](https://github.com/nightjarrr/adda-dev-launcher) — it provides the launcher script, Envoy proxy configuration, and host setup instructions.

---

## Documentation

| Document | Contents |
|---|---|
| [`docs/adda-dev-runtime-design.md`](docs/adda-dev-runtime-design.md) | Conceptual model: design goals, threat model, tier architecture |
| [`docs/adda-dev-runtime-technical-design.md`](docs/adda-dev-runtime-technical-design.md) | Implementation reference: entrypoint sequence, authentication, networking, image build |
| [`docs/proto-adda.md`](docs/proto-adda.md) | proto-adda (Claude Code harness) specifics |
| [`docs/self-hosting.md`](docs/self-hosting.md) | Developing this repo from within itself |

---

## Notes

- **Linux only.** Ubuntu 24.04 is the tested platform. No plans to support other platforms.
- **Ephemeral by design.** The container has no persistent storage. Push commits to GitHub before ending a session — anything not pushed is lost.
- **Personal project.** Features and design reflect personal workflows. PRs from external contributors are not being accepted. Feel free to fork and adapt.

---

## License

MIT — see [LICENSE](LICENSE) for details.
