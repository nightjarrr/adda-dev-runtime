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

## Bun/TypeScript

Source placement by tier:

| Tier | Script | Test |
|------|--------|------|
| Tier 1 | `adda-dev-runtime/src/<name>.ts` | `adda-dev-runtime/src/<name>.test.ts` |
| Tier 2 | `proto-adda/src/<name>.ts` | `proto-adda/src/<name>.test.ts` |

No shebang, no exec bit in sources — the build pipeline injects the shebang via `--banner`.

Every script extends `ScriptBase<TDeps>`. A minimal skeleton:

```typescript
import type { parseArgs } from "node:util";
import type { ShellDep, StdioDep } from "@adda/lib";
import { defaultDeps, ScriptArgsError, ScriptBase } from "@adda/lib";

type ExampleDeps = ShellDep & StdioDep;

export class ExampleScript extends ScriptBase<ExampleDeps> {
    protected argDefinitions(): Parameters<typeof parseArgs>[0] {
        return {
            strict: true,
            options: {
                target: { type: "string" },
            },
        };
    }

    protected async execute(args: ReturnType<typeof parseArgs>): Promise<void> {
        const target = args.values.target as string | undefined;
        if (!target)
            throw new ScriptArgsError("--target is required");

        const result = await this.deps.shell.run(["sometool", target]);
        this.deps.stdio.stdout.write(result.stdout);
    }
}

if (import.meta.main)
    process.exit(await new ExampleScript(defaultDeps).run(process.argv));
```

- `TDeps` is an intersection of capability dep interfaces. `StdioDep` is always required —
  `ScriptBase` uses `this.deps.stdio.stderr` for error output.
- `defaultDeps` (exported from `@adda/lib`) provides the production implementations. The
  constructor accepts `TDeps` directly — used for test injection.
- `strict: true` in `argDefinitions()` causes `parseArgs` to throw on unknown options;
  `ScriptBase` catches this and returns exit code 2. Required-option presence still needs
  explicit validation in `execute()`, as shown above — use `ScriptArgsError` rather than
  `new ScriptError("...", 2)` for argument validation errors.
- `Shell.run` and `Shell.runSh` throw `ScriptShellError` (a `ScriptError` subclass, exit
  code 1) when the command exits non-zero — no manual exit code check needed. Pass
  `{ strict: false }` for calls where a non-zero exit is expected and handled by the
  caller (e.g. a command whose exit code encodes a status, or a `|| true` shell pipeline).
- Import via the `@adda/lib` alias as shown; use `import type` for type-only imports.

## Testing (Bun)

- Constructor injection is the primary testing mechanism for script descendants — no module
  mocking needed.
- `mock.module()` (top-level, before imports) is reserved for capability implementation
  integration tests only, where a Bun built-in must be intercepted before the module loads.
  Never use it in script descendant tests.
- Coverage floor: 95% line / 90% statement, enforced via `bunfig.toml`.
