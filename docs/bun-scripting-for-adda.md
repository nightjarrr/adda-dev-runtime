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
adda-dev-runtime/src/<name>.ts          # script source (no shebang, no exec bit)
adda-dev-runtime/src/<name>.test.ts     # unit tests
```

**Class skeleton:**

```typescript
class MyScript extends ScriptBase<ShellDep & StdioDep> {
    static create(): MyScript {
        return new MyScript({ shell: new BunShell(), stdio: new BunStdio() });
    }

    protected argDefinitions() { /* util.parseArgs options */ }

    protected async execute(): Promise<void> {
        // implementation; throw on error
    }
}

if (import.meta.main)
    process.exit(await MyScript.create().run(process.argv));
```

**`run(argv)`** (implemented in `ScriptBase`):
1. Slices `argv` past the interpreter/script entries
2. Parses args via `util.parseArgs` using `argDefinitions()`
3. Calls `execute()`
4. Returns exit code

**`import.meta.main` convention:** The `import.meta.main` block cannot be exercised in unit tests and will appear as uncovered in coverage reports.

**Exit codes:**
| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Uncaught exception / runtime error |
| 2 | Argument parsing error |

Additional codes: scripts throw subclasses of `ScriptError` (base error class defined in `lib/ScriptBase.ts`); `run()` catches them and maps each to its designated exit code.

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

**Bun implementations:**

| Interface | Implementation | Backing API |
|-----------|---------------|-------------|
| `Shell` | `BunShell` | `Bun.spawn()` — direct process execution, no shell features |
| `FileReader` | `BunFileReader` | `Bun.file().text()` |
| `FileWriter` | `BunFileWriter` | `Bun.write()` |
| `Stdio` | `BunStdio` | `Bun.stdin`, `process.stdout`, `process.stderr` exposed directly as properties |
| `Env` | `BunEnv` | `process.env` |

**Shell note:** `BunShell` uses `Bun.spawn()` — no shell features (no pipes, globs, redirects). Callers needing shell features must invoke a shell explicitly, e.g. `shell.run(["sh", "-c", "cmd1 | cmd2 > out.txt"])`.

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

**Constructor injection** — no `static create()` factory on capability classes. The `static create()` factory on each script wires production implementations. Constructor accepts `TDeps` directly — used for test injection.

```typescript
// production
static create() {
    return new Deploy({ shell: new BunShell(), fileReader: new BunFileReader(), stdio: new BunStdio() });
}

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

---

## Path alias

All scripts in both tiers import from `@adda/lib`:

```typescript
import type { ShellDep, StdioDep } from "@adda/lib";
import { BunShell, BunStdio, ScriptBase, ScriptError } from "@adda/lib";
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

## Build pipeline

**Source placement:**
```
adda-dev-runtime/src/*.ts        # scripts + capability implementations
adda-dev-runtime/src/lib/        # ScriptBase, capability interfaces, Bun implementations
```

**Multi-stage Docker build:**
1. `FROM oven/bun:<version>-slim AS bun-builder` — builder stage at top of Dockerfile
2. `COPY adda-dev-runtime/src/ /build/` — only sources; `.dockerignore` excludes `**/*.test.ts`
3. `bun build /build/*.ts --outdir /build/out/ --target bun --sourcemap=inline --banner "#!/usr/bin/env bun"` — shebang injected by banner, not present in source
4. Strip `.js` extensions from outputs → `chmod +x`
5. Final Tier 1 stage: `COPY --from=bun-builder /build/out/ /usr/local/libexec/adda-dev-runtime/`

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
- `tsc --noEmit`, `biome check adda-dev-runtime/src/`

**CI-only (`.github/workflows/base.yml`, not in container):**
- `shellcheck` — pre-installed on `ubuntu-latest` runner
- `hadolint` — via `hadolint/hadolint-action`
- All local gate commands also run as explicit CI steps via `oven-sh/setup-bun`

---

## Toolchain — global in Tier 1 image

Installed globally so tools are always available regardless of project tier:

| Tool | Install method | Rationale |
|------|---------------|-----------|
| Biome | `curl` from GitHub releases, standalone binary, pinned version | No npm needed; consistent with delta/micro/ripgrep pattern |
| `tsc` | `BUN_INSTALL=/usr/local bun install -g typescript@<pin>` | Bun-native global install |
| `@types/bun` | `BUN_INSTALL=/usr/local bun install -g @types/bun@<pin>` | Required by tsc; globally available |

Tier 1 made the Bun runtime choice; bundling its verification toolchain is consistent with existing dev tools already in the image.

---

## Package manifest

- `package.json` at repo root — settled convention; available for future use
- `@types/bun` is globally installed in the Tier 1 image; CI installs it the same way via `BUN_INSTALL=/usr/local bun install -g`
- Biome is globally installed; not a devDep
- `tsconfig.json`: strict, `noEmit`, `ESNext` target/module, `moduleResolution: bundler`, `skipLibCheck`, `types: ["bun"]`, `typeRoots: ["/usr/local/install/global/node_modules/@types"]`, `baseUrl: "."`, `paths` for `@adda/lib`
- `bunfig.toml`: `coverageThreshold` line/function/statement = 90
- `biome.json`: recommended TS rules + `no-console` enforcement on `adda-dev-runtime/src/`
