# Contributing

This is a personal project developed for the author's own use. It is shared publicly in the hope it may be useful to others, but **pull requests from external contributors are not being accepted** at this time.

The project is licensed under the MIT license (see [LICENSE](LICENSE)). You are welcome to fork it and adapt it to your own needs.

## Bug reports and feature suggestions

Bug reports and feature suggestions are welcome via [GitHub Issues](https://github.com/nightjarrr/adda-dev-runtime/issues). Please understand that this is a single-author project and issues may not be addressed promptly.

## Forks

If you fork this project and make improvements, you are welcome to describe your changes via an issue for case-by-case consideration.

## Development setup

This repository is designed to be developed from inside the ADDA Dev Runtime. See the [README](README.md#requirements) for host system prerequisites (Docker, tmux, keyring, etc.) and setup instructions.

**Container toolchain:**
- [Bun](https://bun.sh) — JavaScript/TypeScript runtime (pre-installed in the dev runtime)
- `oxlint` / `oxfmt` — linting and formatting (repo devDependencies, invoke via `bun run oxlint` / `bun run oxfmt`)
- `tsc` — TypeScript type checking (invoke via `bun run tsc --noEmit`)
- `bun test` — test runner with coverage

**Pre-commit quality gates:** the repository is configured with a pre-commit hook that runs all quality gates locally before each commit. If a commit is blocked, address the reported issue, re-stage, and commit again.
