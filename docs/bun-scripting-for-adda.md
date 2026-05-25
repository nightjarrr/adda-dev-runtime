# Bun/TypeScript CLI Scripting for ADDA Dev Runtime

Design reference for Tier 1 scripts written in TypeScript and executed by Bun.

---

## Why Bun

- Already installed in Tier 1 image; zero additional runtime cost
- Native TypeScript execution — no transpile step at dev time
- Built-in test runner, coverage reporter, and bundler
- `node` symlink provided; no separate Node installation needed

---

## Script structure (mandatory pattern)

Every script is a class descending from `ScriptBase<TDeps>`.

```
adda-dev-runtime/src/<name>.ts          # script source (no shebang, no exec bit)
adda-dev-runtime/src/<name>.test.ts     # unit tests
```

**Class skeleton:**

```typescript
class MyScript extends ScriptBase<Shell & Stdio> {
    static create(): MyScript {
        return new MyScript({ shell: new BunShell(), stdio: new BunStdio() });
    }

    protected argDefinitions() { /* util.parseArgs options */ }

    protected async execute(): Promise<void> {
        // implementation; throw on error
    }
}

if (import.meta.main) process.exit(await MyScript.create().run(process.argv));
```

**`run(argv)`** (implemented in `ScriptBase`):
1. Slices `argv` past the interpreter/script entries
2. Parses args via `util.parseArgs` using `argDefinitions()`
3. Calls `execute()`
4. Returns exit code

**Exit codes:**
| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Uncaught exception / runtime error |
| 2 | Argument parsing error |

Additional codes expressed via typed exception hierarchy extending a base `ScriptError`.

---

## Capabilities

Capabilities are interfaces representing external services. A script declares exactly the capabilities it needs via intersection types on the `TDeps` generic.

**Interfaces:**

| Interface | Responsibility |
|-----------|---------------|
| `Shell` | Execute subprocesses |
| `FileReader` | Read file contents |
| `FileWriter` | Write file contents |
| `Stdio` | Write to stdout / stderr |
| `Env` | Read environment variables |

**Bun implementations:**

| Interface | Implementation | Backing API |
|-----------|---------------|-------------|
| `Shell` | `BunShell` | Bun `$` template tag |
| `FileReader` | `BunFileReader` | `Bun.file().text()` |
| `FileWriter` | `BunFileWriter` | `Bun.write()` |
| `Stdio` | `BunStdio` | `process.stdout` / `process.stderr` |
| `Env` | `BunEnv` | `process.env` |

**`TDeps extends Stdio`** — `Stdio` is always mandatory; `ScriptBase` uses it for error output.

**Composition example:**

```typescript
class Deploy extends ScriptBase<Shell & FileReader & Stdio> { ... }
```

**`static create()` factory** wires production implementations. Constructor accepts `TDeps` directly — used for test injection.

```typescript
// production
static create() { return new Deploy({ shell: new BunShell(), fileReader: new BunFileReader(), stdio: new BunStdio() }); }

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

Dynamic `import()` inside test functions is required when the module under test must be loaded after `mock.module()` is registered. Static imports are fine for pure functions that do not touch Bun built-ins.

---

## Mocking

Constructor injection is the primary mechanism — no module mocking required for script tests.

Mocks satisfy interfaces via structural typing; no `implements` declaration needed:

```typescript
const mockShell: Shell = {
    run: mock(async () => ({ stdout: "ok", exitCode: 0 }))
};
```

`mock.module()` (top-level, before imports) is reserved for wrapping Bun built-in APIs in capability implementations when integration-testing those implementations in isolation.

---

## Coverage

- Target: 95%
- Enforced floor: 90% (line / function / statement) via `bunfig.toml` `coverageThreshold`

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
- Session 1: `bun test --coverage`, `bun build`
- Session 2: `tsc --noEmit`, `biome check` (tools not available until Session 1 image merges)

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

- `package.json` + `bun.lockb` at repo root — settled convention; available for future use
- Current sole devDep: `@types/bun` — CI type-checking anchor (`bun install` in CI workflow satisfies `tsc`)
- Biome is globally installed; not a devDep
- `tsconfig.json`: strict, `noEmit`, `ESNext` target/module, `moduleResolution: bundler`, `skipLibCheck`, `types: ["bun-types"]`
- `bunfig.toml`: `coverageThreshold` line/function/statement = 90
- `biome.json`: recommended TS rules + `no-console` enforcement on `adda-dev-runtime/src/`
