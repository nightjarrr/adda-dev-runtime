# Bun/TypeScript CLI Scripting for ADDA Dev Runtime

Design reference for Tier 1 scripts written in TypeScript and executed by Bun.

---

## Why Bun

- Already installed in Tier 1 image; zero additional runtime cost
- Native TypeScript execution — no transpile step at dev time
- Built-in test runner, coverage reporter, and bundler

---

## Script structure (mandatory pattern)

Every script is a class descending from `ScriptBase<TDeps>`.

```
adda-dev-runtime/src/runtime/<name>.ts          # runtime script source (bin/; no shebang, no exec bit)
adda-dev-runtime/src/runtime/<name>.test.ts     # unit tests
adda-dev-runtime/src/bootstrap/<name>.ts        # bootstrap script source (bootstrap/; no shebang, no exec bit)
adda-dev-runtime/src/bootstrap/<name>.test.ts   # unit tests
```

**Class skeleton:**

```typescript
class MyScript extends ScriptBase<ShellDep & StdioDep, MyArgs> {
    protected argDefinitions() { /* util.parseArgs options */ }

    protected validateArgs(parsed: ReturnType<typeof parseArgs>): MyArgs {
        // validate and extract args; throw ScriptArgsError on invalid input
    }

    protected async execute(args: MyArgs): Promise<void> {
        // implementation; throw on error
    }
}

if (import.meta.main)
    process.exit(await new MyScript(defaultDeps).run(process.argv));
```

**`run(argv)`** (implemented in `ScriptBase`):
1. Slices `argv` past the interpreter/script entries
2. Parses args via `util.parseArgs` using `argDefinitions()`
3. Calls `validateArgs()` to produce typed `TArgs`
4. Calls `execute(args)` with the validated result
5. Returns exit code

**`import.meta.main` convention:** The `import.meta.main` block cannot be exercised in unit tests and will appear as uncovered in coverage reports.

**Exit codes:**
| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Uncaught exception / runtime error |
| 2 | Argument parsing error |

Additional codes: scripts throw subclasses of `ScriptError` (base error class defined in `lib/ScriptBase.ts`); `run()` catches them and maps each to its designated exit code. `ScriptShellError` (exit code 1) is thrown automatically by `Shell.run`/`Shell.runSh` when a spawned command exits non-zero (strict mode, on by default); pass `{ strict: false }` to suppress this and handle the exit code manually.

---

## Script output envelope

All scripts emit a single-line JSON envelope on stdout. Scripts that produce a file artifact
(e.g. rendered markdown) take `--output <path>` and surface the resolved path in `result`.

### Shape

```json
{ "status": "ok",   "result": { ...script-specific payload... }, "error": null }
{ "status": "fail", "result": null, "error": { "reason": "...", "message": "...", "details": {} } }
```

**`status: "ok"`** — the script ran to completion and produced a result. Exit 0.
`result` carries the payload; it may encode an unfavorable determination (e.g. CI failed,
gates FAIL). `error` is always `null`.

**`status: "fail"`** — the script could not produce a result. Exit non-zero (2 for arg
errors, 1 for all others). `result` is always `null`. `error` carries:
- `reason` — typed code for programmatic branching
- `message` — human-readable description
- `details` — script-specific extra context (may be empty `{}`)

### Parsing

Use `makeEnvelopeSchema` (from `@adda/lib`) with a Zod `discriminatedUnion` on `"status"` for one-step type-safe parsing:

```typescript
import { makeEnvelopeSchema } from "@adda/lib";
import { z } from "zod";

const ResultSchema = z.object({ id: z.string(), name: z.string() });
const EnvelopeSchema = makeEnvelopeSchema(ResultSchema);

const parsed = EnvelopeSchema.safeParse(parseJson(stdout));
// TypeScript narrows: parsed.data.status === "ok" → result is non-null
```

### Dual signal: exit code and status

Exit code and `status` always agree and serve different consumers:
- Exit code → shell / subprocess layer (`exitCode !== 0` pre-check before parsing)
- `status` → JSON schema layer (Zod discriminated union, TypeScript narrowing)

### Error implementation

Scripts implement errors as a `ScriptStructuredError` subclass carrying the fail envelope.
`ScriptBase.run()` catches it and auto-emits the envelope — no manual emit at error
sites. Success paths call `this.emitOk(...)` once and return.

```typescript
import { ScriptStructuredError } from "@adda/lib";
import type { BaseReason } from "@adda/lib";

type MyReason = BaseReason | "repo_not_found";
class MyScriptError extends ScriptStructuredError<MyReason> {}

// Error sites — throw the subclass directly:
throw new MyScriptError("repo_not_found", `repo ${owner}/${repo} not found`);
// Success sites — pass the result object:
this.emitOk<MyResult>({ id: "...", name: "..." });
return;
```

---

## Capabilities

Capabilities are interfaces representing external services. A script declares exactly the capabilities it needs via intersection types on the `TDeps` generic.

**Interfaces:**

| Interface | Responsibility |
|-----------|---------------|
| `Shell` | Execute subprocesses |
| `FileReader` | Read file contents |
| `FileWriter` | Write file contents |
| `Stdio` | Read from stdin; write to stdout / stderr |
| `Env` | Read environment variables |

**Bun implementations** are bundled in `defaultDeps` (exported from `@adda/lib`), used for production wiring:

| Interface | Backing API |
|-----------|-------------|
| `Shell` | `run()`: `Bun.spawn()` — direct process execution; `runSh()`: via `sh -c` |
| `FileReader` | `Bun.file().text()` |
| `FileWriter` | `Bun.write()` |
| `Stdio` | `Bun.stdin`, `process.stdout`, `process.stderr` |
| `Env` | `process.env` |
| `Tmp` | `crypto.randomUUID()` / `mkdtempSync()` |

**Shell note:** `run()` uses `Bun.spawn()` directly — no shell features (no pipes, globs, redirects). `runSh()` wraps `sh -c` and has full shell features.

**Dep interfaces:** Each capability has a paired Dep interface that names the property used in the script's deps object:

```typescript
interface ShellDep    { shell:      Shell      }
interface FileReaderDep { fileReader: FileReader }
interface FileWriterDep { fileWriter: FileWriter }
interface StdioDep    { stdio:      Stdio      }
interface EnvDep      { env:        Env        }
```

**`TDeps extends StdioDep`** — `StdioDep` is always mandatory; `ScriptBase` uses `this.deps.stdio.stderr` for error output.

**Composition example:**

```typescript
type DeployDeps = ShellDep & FileReaderDep & StdioDep;

class Deploy extends ScriptBase<DeployDeps> { ... }
```

`& StdioDep` in the type argument is mandatory, not decorative — `TDeps extends StdioDep` is enforced at compile time.

**Constructor injection** — `defaultDeps` (from `@adda/lib`) wires production implementations. The constructor accepts `TDeps` directly — used for test injection.

```typescript
// production
new Deploy(defaultDeps);

// test
new Deploy({ shell: mockShell, fileReader: mockFileReader, stdio: mockStdio });
```

---

## Testing layers

| Subject | Test type | Mechanism |
|---------|-----------|-----------|
| `ScriptBase` | Unit | Constructor injection with mocks; 100% coverage required |
| Each capability implementation | Integration | Tests against real Bun APIs in isolation |
| Script descendants | Unit | Constructor injection with mocked capabilities |

Dynamic `import()` inside test functions applies only to capability implementation integration tests — when `mock.module()` must be registered before the module loads. Script descendant tests use constructor injection exclusively; dynamic imports are never required there.

---

## Mocking

Constructor injection is the primary mechanism — no module mocking required for script tests.

Mocks satisfy interfaces via structural typing; no `implements` declaration needed:

```typescript
const mockShell: Shell = {
    run: mock(async () => ({ stdout: "ok", stderr: "", exitCode: 0 }))
};

const mockStdio: Stdio = {
    stdin: { text: mock(async () => "") },
    stdout: { write: mock((_text: string) => {}) },
    stderr: { write: mock((_text: string) => {}) },
};
```

`mock.module()` (top-level, before imports) is reserved for wrapping Bun built-in APIs in capability implementations when integration-testing those implementations in isolation.

**Why `mock.module()` is banned from script descendant tests:** Bun's test runner executes all test files in the same process. The module registry is shared — a `mock.module()` in one file leaks into every file loaded afterward in the same run. Alias-based mocks (`mock.module("@adda/lib", ...)`) are additionally environment-sensitive: the alias may not resolve the same way locally and in CI, making the mock apply in one environment but not the other. The concrete failure mode: if a library function captures `defaultDeps` at module level and a test exercises a code path that reaches it, the real filesystem is written regardless of what mocks were passed to the script constructor.

**Design constraint that makes constructor injection sufficient:** Every I/O operation must be a method on a capability interface — never a standalone function that captures `defaultDeps` at module level. If an operation belongs to a capability's responsibility (file writing, renaming, etc.), put it on that capability's interface so scripts access it through `this.deps`. This is what makes `mock.module()` unnecessary for script descendant tests: all I/O is injectable.

---

## Path alias

All scripts in both tiers import from `@adda/lib`:

```typescript
import type { ShellDep, StdioDep } from "@adda/lib";
import { defaultDeps, ScriptBase, ScriptError } from "@adda/lib";
```

The alias is configured in `tsconfig.json`:

```json
"baseUrl": ".",
"paths": {
    "@adda/lib": ["adda-dev-runtime/src/lib"],
    "@adda/lib/*": ["adda-dev-runtime/src/lib/*"]
}
```

Bun resolves path aliases from `tsconfig.json` at runtime — no separate bundler configuration needed.

---

## Coverage

- Target: 95%
- Enforced floor: 95% line, 90% statement via `bunfig.toml` `coverageThreshold` (function metric excluded — non-deterministic for implicit constructors)
- Bun supports no line-level coverage ignore annotations; factor this in when setting coverage targets.

---

## Runtime data validation

Use Zod for all external API responses and parsed JSON. It is a `dependencies` entry in `package.json` (bundled into executables by `bun build`).

**Declare a schema:**

```typescript
import { z } from "zod";

const ResultSchema = z.object({ id: z.number(), name: z.string() });
```

**Always use `parseJson` (from `@adda/lib`) instead of bare `JSON.parse`** at all external data boundaries — it wraps `JSON.parse` and throws a diagnostic `ScriptError` (with the raw content included) on invalid input, rather than a bare `SyntaxError`.

**Always use `.safeParse()`, never `.parse()`** — let `ScriptZodValidationError` handle the failure path:

```typescript
import { parseJson, ScriptZodValidationError } from "@adda/lib";

const raw = parseJson(ghResult.stdout);
const parsed = ResultSchema.safeParse(raw);
if (!parsed.success)
    throw new ScriptZodValidationError("unexpected API response", parsed.error, raw);
const { id, name } = parsed.data;
```

**`ScriptZodValidationError(context, error, rawInput?)`:**
- `error.message` — full diagnostics (all Zod issue paths + raw input); written to stderr by `ScriptBase`
- `error.short` — compact issues-only string; available for callers that also emit structured stdout (e.g. `emit()`)

For scripts that emit structured stdout on error:

```typescript
if (!parsed.success) {
    const err = new ScriptZodValidationError("unexpected API response", parsed.error, raw);
    this.emit(issueId, "error", "", "", err.short);
    throw err;
}
```

**Schema violation vs domain condition:** use `.nullable()` on fields the API legitimately returns null (e.g. repository not found, issue not found); keep non-nullable for fields that must always be present — their absence is a schema failure.

---

## Build pipeline

**Source placement:**
```
adda-dev-runtime/src/runtime/    # runtime scripts (compile to bin/)
adda-dev-runtime/src/bootstrap/  # bootstrap scripts (compile to bootstrap/)
adda-dev-runtime/src/lib/        # ScriptBase, capability interfaces, Bun implementations (shared; not deployed directly)
```

**Multi-stage Docker build:**
1. `FROM oven/bun:<version>-slim AS bun-builder` — builder stage at top of Dockerfile
2. `COPY package.json bun.lock tsconfig.json /build/` + `COPY adda-dev-runtime/src/ /build/adda-dev-runtime/src/` — package manifest and lockfile included so `bun install` can resolve production dependencies (e.g. Zod) before bundling
3. `RUN bun install --frozen-lockfile` — installs production deps into the builder stage; `bun build` then bundles them into the output executables
4. Build runtime scripts: `bun build /build/adda-dev-runtime/src/runtime/*.ts --outdir /build/out/bin/ --target bun --sourcemap=inline --banner "#!/usr/bin/env bun"` — shebang injected by banner, not present in source
   - Add `bun build /build/adda-dev-runtime/src/bootstrap/*.ts --outdir /build/out/bootstrap/ ...` when bootstrap Bun scripts exist
5. Strip `.js` extensions from outputs per subdirectory → `chmod +x` per subdirectory. `out/` mirrors the target's `bin/`/`bootstrap/` layout.
6. Final Tier 1 stage: `COPY --from=bun-builder /build/out/ /usr/local/libexec/adda-dev-runtime/` — Docker merges directories; bootstrap shell scripts already present under `bootstrap/` are untouched.

**`.dockerignore`** excludes:
- `**/*.test.ts`
- `**/node_modules`
- `.git`

No shebang or exec bit in TypeScript sources.

---

## Quality gates

Two distinct layers:

**Local (`.quality-gates.conf`, runs in container):**
- `bun test --coverage`, `bun build`
- `tsc --noEmit`, `oxlint adda-dev-runtime/src/ proto-adda/src/`, `oxfmt --check adda-dev-runtime/src/ proto-adda/src/`

**CI-only (`.github/workflows/base.yml`, not in container):**
- `shellcheck` — pre-installed on `ubuntu-latest` runner
- `hadolint` — via `hadolint/hadolint-action`
- All local gate commands also run as explicit CI steps via `oven-sh/setup-bun`

---

## Toolchain — repo devDependencies, installed at bootstrap

`oxlint`, `oxfmt`, and `typescript` (for `tsc`) are listed as `devDependencies`
in `package.json` and installed by `.adda-init.sh` at container start. They are
available on `PATH` via `/workspace/node_modules/.bin`.

| Tool | devDependency | Rationale |
|------|--------------|-----------|
| `oxlint` | `oxlint@<pin>` | Fast TypeScript/JS linter; replaces Biome lint |
| `oxfmt` | `oxfmt@<pin>` | TypeScript/JS formatter; replaces Biome format |
| `tsc` | `typescript@<pin>` | Type checking; previously a Tier 1 global |

These are dev-time tools for this repo only — not runtime tools any Tier 2/3
consumer needs. Keeping them out of the Tier 1 image reduces image size by ~78 MB.

---

## Package manifest

- `package.json` at repo root — settled convention
- `@types/bun` is listed under `devDependencies` and installed at bootstrap time; it is type-only and never bundled.
- **`dependencies`** — packages imported in production source and bundled into executables by `bun build`. Example: `"zod": "4.4.3"`. Add new production deps here.
- **`devDependencies`** — packages used only for type-checking or tooling, never bundled. Examples: `"@types/bun": "1.3.14"`, `"oxlint": "1.68.0"`, `"oxfmt": "0.53.0"`, `"typescript": "6.0.3"`. These are never imported in runtime source.
- `tsconfig.json`: strict, `noEmit`, `ESNext` target/module, `moduleResolution: bundler`, `skipLibCheck`, `types: ["bun"]`, `baseUrl: "."`, `paths` for `@adda/lib`
- `bunfig.toml`: `coverageThreshold` line/function/statement = 90
- `.oxlintrc.json`: recommended rules + `no-console: error`
- `.oxfmtrc.json`: `useTabs: false`, `tabWidth: 4`, `printWidth: 128`
