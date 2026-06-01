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

- Tier 1 scripts live under `adda-dev-runtime/content/scripts/<bootstrap|runtime>/`.
- Tier 2 scripts live under `proto-adda/content/scripts/<bootstrap|runtime>/`.
  Hook scripts (sourced by entrypoint) additionally live under `entrypoint.d/` within the bootstrap directory.

Apply all bash conventions above.

## Dockerfiles

- First line: `# syntax=docker/dockerfile:1.7`.
- `# hadolint ignore=<rule>` requires a `# Why:` comment on the immediately preceding line
  (hadolint suppression must be the line immediately before the `RUN` instruction).
- All `RUN` steps must pass `hadolint` (enforced in CI `base.yml`).

## Bun/TypeScript

Source placement by tier and purpose:

| Tier | Purpose | Script | Test |
|------|---------|--------|------|
| Tier 1 | runtime (bin/) | `adda-dev-runtime/src/runtime/<name>.ts` | `adda-dev-runtime/src/runtime/<name>.test.ts` |
| Tier 1 | bootstrap | `adda-dev-runtime/src/bootstrap/<name>.ts` | `adda-dev-runtime/src/bootstrap/<name>.test.ts` |
| Tier 2 | runtime (bin/) | `proto-adda/src/runtime/<name>.ts` | `proto-adda/src/runtime/<name>.test.ts` |
| Tier 2 | bootstrap | `proto-adda/src/bootstrap/<name>.ts` | `proto-adda/src/bootstrap/<name>.test.ts` |

No shebang, no exec bit in sources — the build pipeline injects the shebang via `--banner`.

Every script extends `ScriptBase<TDeps, TArgs>`. A minimal skeleton:

```typescript
import type { parseArgs } from "node:util";
import type { ShellDep, StdioDep } from "@adda/lib";
import { defaultDeps, ScriptArgsError, ScriptBase } from "@adda/lib";

type ExampleDeps = ShellDep & StdioDep;
type ExampleArgs = { target: string };

export class ExampleScript extends ScriptBase<ExampleDeps, ExampleArgs> {
    protected argDefinitions(): Parameters<typeof parseArgs>[0] {
        return {
            strict: true,
            options: {
                target: { type: "string" },
            },
        };
    }

    protected validateArgs(parsed: ReturnType<typeof parseArgs>): ExampleArgs {
        const target = parsed.values.target as string | undefined;
        if (!target)
            throw new ScriptArgsError("--target is required");
        return { target };
    }

    protected async execute(args: ExampleArgs): Promise<void> {
        const result = await this.deps.shell.run(["sometool", args.target]);
        this.deps.stdio.stdout.write(result.stdout);
    }
}

if (import.meta.main)
    process.exit(await new ExampleScript(defaultDeps).run(process.argv));
```

- `TDeps` is an intersection of capability dep interfaces. `StdioDep` is always required —
  `ScriptBase` uses `this.deps.stdio.stderr` for error output.
- `TArgs` is the validated, typed result of `validateArgs()`. Use `EmptyArgs` (exported from
  `@adda/lib`) for scripts that take no arguments.
- `defaultDeps` (exported from `@adda/lib`) provides the production implementations. The
  constructor accepts `TDeps` directly — used for test injection.
- `strict: true` in `argDefinitions()` causes `parseArgs` to throw on unknown options;
  `ScriptBase` catches this and returns exit code 2. Required-option presence is validated
  in `validateArgs()`, as shown above — use `ScriptArgsError` rather than
  `new ScriptError("...", 2)` for argument validation errors.
- `Shell.run` and `Shell.runSh` throw `ScriptShellError` (a `ScriptError` subclass, exit
  code 1) when the command exits non-zero — no manual exit code check needed. Pass
  `{ strict: false }` for calls where a non-zero exit is expected and handled by the
  caller (e.g. a command whose exit code encodes a status, or a `|| true` shell pipeline).
- Import via the `@adda/lib` alias as shown; use `import type` for type-only imports.

## Runtime data validation (Bun)

Use Zod (`import { z } from "zod"`) for all external API responses and parsed JSON. Import `ScriptZodValidationError` from `@adda/lib` for the failure path.

**Canonical pattern:**

```typescript
import { z } from "zod";
import { ScriptZodValidationError } from "@adda/lib";

const ResultSchema = z.object({ id: z.number(), name: z.string() });

const raw = JSON.parse(ghResult.stdout);
const parsed = ResultSchema.safeParse(raw);
if (!parsed.success)
    throw new ScriptZodValidationError("unexpected API response", parsed.error, raw);
const { id, name } = parsed.data;
```

For scripts that also emit structured stdout on error (e.g. `resolve-issue-branch`):

```typescript
if (!parsed.success) {
    const err = new ScriptZodValidationError("unexpected API response", parsed.error, raw);
    this.emit(issueId, "error", "", "", err.short);
    throw err;
}
```

Always use `.safeParse()`, never `.parse()`. Use `.nullable()` on fields the API legitimately returns null (domain conditions such as repository or issue not found); keep non-nullable for fields that must always be present — their absence is a schema failure.

## Testing (Bun)

- Constructor injection is the primary testing mechanism for script descendants — no module
  mocking needed.
- `mock.module()` (top-level, before imports) is reserved for capability implementation
  integration tests only, where a Bun built-in must be intercepted before the module loads.
  Never use it in script descendant tests.
- Coverage floor: 95% line / 90% statement, enforced via `bunfig.toml`.
