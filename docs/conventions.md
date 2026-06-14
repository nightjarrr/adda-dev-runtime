# Conventions

## Bash

- Open with `#!/bin/bash` and `set -euo pipefail`.
- Begin each script with a brief comment block stating purpose, inputs, and outputs (and sourcing
  context if the script is sourced rather than executed).
- Structure logic into named functions; group related functions under `# ---`-delimited section
  headings.
- `# shellcheck disable=SC…` requires a `# Why:` comment on the immediately following line.
- The `section`/`die`/`warning`/`success` helpers are defined in
  `bootstrap/phases/00-helpers.sh` and available in all phases and sourced entrypoint hooks
  (`entrypoint.d/*.sh`); not in standalone scripts.

## .sh.source files

Scripts baked to `/usr/local/libexec/adda-dev-runtime/` carry a `.sh.source` extension in
the repo and no exec bit. The Dockerfile `RUN` step renames them (strips `.source`) and
sets the exec bit with `chmod`. This convention applies to all scripts baked to that path
regardless of tier:

- Tier 1 scripts live under `adda-dev-runtime/content/scripts/<bootstrap|runtime>/`.
- Tier 2 scripts live under `proto-adda/content/scripts/<bootstrap|runtime>/`.
  Hook scripts (sourced by entrypoint) additionally live under `entrypoint.d/` within the bootstrap directory.

Scripts used only during Docker image build stages (not baked into any image) live under
`adda-dev-runtime/build/` and use a plain `.sh` extension with the exec bit set in the repo.

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
type ExampleResult = { output: string };

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
        this.emitOk<ExampleResult>({ output: result.stdout.trim() });
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
  in `validateArgs()`, as shown above — use `ScriptArgsError` for argument validation errors.
- `Shell.run` and `Shell.runSh` throw `ScriptShellError` (a `ScriptError` subclass, exit
  code 1) when the command exits non-zero — no manual exit code check needed. Pass
  `{ strict: false }` for calls where a non-zero exit is expected and handled by the
  caller (e.g. a command whose exit code encodes a status, or a `|| true` shell pipeline).
- Import via the `@adda/lib` alias as shown; use `import type` for type-only imports.

## Runtime data validation (Bun)

Use Zod (`import { z } from "zod"`) for all external API responses and parsed JSON. Import `ScriptZodValidationError` from `@adda/lib` for the failure path.

**JSON parsing:**

Always use `parseJson` (from `@adda/lib`) instead of bare `JSON.parse` at external data boundaries — it catches `SyntaxError` and produces a diagnostic `ScriptError` that includes the raw content:

```typescript
import { parseJson } from "@adda/lib";

const raw = parseJson(ghResult.stdout); // throws ScriptError with raw content on invalid JSON
const parsed = ResultSchema.safeParse(raw);
```

**Canonical Zod pattern:**

```typescript
import { z } from "zod";
import { parseJson, ScriptZodValidationError } from "@adda/lib";

const ResultSchema = z.object({ id: z.number(), name: z.string() });

const raw = parseJson(ghResult.stdout);
const parsed = ResultSchema.safeParse(raw);
if (!parsed.success)
    throw new ScriptZodValidationError("unexpected API response", parsed.error, raw);
const { id, name } = parsed.data;
```

Always use `.safeParse()`, never `.parse()`. Use `.nullable()` on fields the API legitimately returns null (domain conditions such as repository or issue not found); keep non-nullable for fields that must always be present — their absence is a schema failure.

## Script output envelope (Bun)

Scripts emit a single-line JSON envelope to stdout; `ScriptBase.run()` owns all emit paths.
Never write to `this.deps.stdio.stdout` directly in `execute()`.

**Envelope shape:**
```json
{ "status": "ok",   "result": { ...payload... }, "error": null }
{ "status": "fail", "result": null, "error": { "reason": "...", "message": "...", "details": {} } }
```

**Success:** call `this.emitOk<T>(result)` at the end of `execute()`.

**Error:** throw any `ScriptError` subclass — `run()` catches it and emits the fail envelope
automatically. No manual emit at error sites. Declare a module-level subclass to add typed
reason codes:

```typescript
import { ScriptError } from "@adda/lib";
import type { BaseReason, GithubReason } from "@adda/lib";

type MyReason = BaseReason | GithubReason | "quota_exceeded";
class MyScriptError extends ScriptError<MyReason> {}

throw new MyScriptError("quota_exceeded", "rate limit hit", { details: { retryAfter: 60 } });
```

`BaseReason` codes: `invalid_args`, `invalid_config`, `missing_env`, `api_error`,
`validation_error`, `shell_error`, `internal_error`, `ambiguous_result`. Use `GithubReason`
(`repo_not_found`, `issue_not_found`, `pr_not_found`, `thread_not_found`, `not_a_thread`) in
any script that calls the GitHub API.

**Parsing another script's envelope:** use `makeEnvelopeSchema` (from `@adda/lib`) with a Zod
result schema — it returns a discriminated union schema that TypeScript narrows correctly:

```typescript
const ResultSchema = z.object({ id: z.string() });
const EnvelopeSchema = makeEnvelopeSchema(ResultSchema);
const parsed = EnvelopeSchema.safeParse(parseJson(result.stdout));
// status === "ok"   → result non-null, error null
// status === "fail" → result null, error non-null
```

## Testing (Bun)

- Constructor injection is the primary testing mechanism for script descendants — no module
  mocking needed.
- `mock.module()` (top-level, before imports) is reserved for capability implementation
  integration tests only, where a Bun built-in must be intercepted before the module loads.
  Never use it in script descendant tests. Bun's test runner shares a single module registry
  across all files in a process run — a `mock.module()` in one file leaks into files loaded
  afterward. Alias-based mocks (`"@adda/lib"`) are additionally environment-sensitive and
  may apply in CI but not locally (or vice versa).
- All I/O operations must be methods on a capability interface, never standalone functions
  that capture `defaultDeps` at module level. A function that performs I/O by closing over
  `defaultDeps` is invisible to constructor injection — tests that exercise it will always
  hit the real filesystem. Putting the operation on the capability interface (e.g.
  `FileWriter.writeFile`) is what makes constructor injection sufficient.
- Coverage floor: 95% line / 90% statement, enforced via `bunfig.toml`.

## FileWriter.writeFile

All writes use `fileWriter.writeFile(pathPattern, content)` — the single write method on
`FileWriter`. It is always atomic (temp file + same-directory rename), supports placeholder
expansion in `pathPattern`, and returns the resolved path as `Promise<string>`.

Supported placeholders: `<tmpDir>` (OS temp directory), `<uuid>` (random UUID v4),
`<ts>` (epoch milliseconds as a string). Combine them freely, e.g.
`<tmpDir>/my-tool-results-<uuid>.json`.

`expandPath(pattern)` (exported from `@adda/lib`) performs the same placeholder expansion
without writing — use it when you need a resolved path for a purpose other than a file write
(e.g. passing a path to an external tool).

There is no non-atomic write method and no decision to make: use `writeFile` for every write.
