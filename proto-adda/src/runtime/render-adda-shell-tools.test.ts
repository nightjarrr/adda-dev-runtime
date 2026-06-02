import { describe, expect, mock, test } from "bun:test";
import type { FileReader, FileReaderDep, Shell, ShellDep, ShellResult, StdioDep } from "@adda/lib";
import {
    CONSTRAINED_PROBES,
    FALLBACK,
    parseTools,
    RenderAddaShellTools,
    render,
    renderAbsent,
    renderConstrainedPresent,
    renderScriptingAlternatives,
    renderToolsTable,
    SCRIPTING_PROBES,
} from "./render-adda-shell-tools";

// --- Mock helpers ---

type RenderAddaShellToolsDeps = FileReaderDep & ShellDep & StdioDep;

/**
 * All known probe names: used by tests that want a specific set to be present or absent.
 * Keys from both probe maps.
 */
const ALL_PROBE_NAMES = [...Object.keys(SCRIPTING_PROBES), ...Object.keys(CONSTRAINED_PROBES)];

function makeMockDeps(options: { fileContent?: string | Error; whichResults?: Record<string, number> }): {
    deps: RenderAddaShellToolsDeps;
    outLines: string[];
    errLines: string[];
} {
    const outLines: string[] = [];
    const errLines: string[] = [];

    const mockFileReader: FileReader = {
        readFile: mock(async (_path: string): Promise<string> => {
            if (options.fileContent instanceof Error) throw options.fileContent;
            return options.fileContent ?? "";
        }),
    };

    const whichResults = options.whichResults ?? {};
    const mockShell: Shell = {
        run: mock(async (command: string[], _opts?: { strict?: boolean }): Promise<ShellResult> => {
            // All calls in this script are `which <toolName>` with strict: false
            const toolName = command[1] ?? "";
            const exitCode = whichResults[toolName] ?? 0;
            return { stdout: exitCode === 0 ? `/usr/bin/${toolName}` : "", stderr: "", exitCode };
        }),
        runSh: mock(
            async (_cmd: string, _opts?: { strict?: boolean }): Promise<ShellResult> => ({
                stdout: "",
                stderr: "",
                exitCode: 0,
            }),
        ),
    };

    const deps: RenderAddaShellToolsDeps = {
        fileReader: mockFileReader,
        shell: mockShell,
        stdio: {
            stdin: { text: mock(async () => "") },
            stdout: {
                write: mock((text: string) => {
                    outLines.push(text);
                }),
            },
            stderr: {
                write: mock((text: string) => {
                    errLines.push(text);
                }),
            },
        },
    };

    return { deps, outLines, errLines };
}

/** All probes present (exit code 0). */
function allPresent(): Record<string, number> {
    return Object.fromEntries(ALL_PROBE_NAMES.map((t) => [t, 0]));
}

/** All probes absent (exit code 1). */
function allAbsent(): Record<string, number> {
    return Object.fromEntries(ALL_PROBE_NAMES.map((t) => [t, 1]));
}

// --- parseTools ---

describe("parseTools", () => {
    test("parses valid JSONL with multiple tools", () => {
        const raw = '{"name":"rg","cmd":"rg <pattern>","desc":"Fast search"}\n{"name":"jq","cmd":"jq .","desc":"JSON"}';
        const tools = parseTools(raw);
        expect(tools).toHaveLength(2);
        expect(tools[0]).toEqual({ name: "rg", cmd: "rg <pattern>", desc: "Fast search" });
        expect(tools[1]).toEqual({ name: "jq", cmd: "jq .", desc: "JSON" });
    });

    test("skips blank lines", () => {
        const raw = '{"name":"rg","cmd":"rg <pattern>","desc":"Fast search"}\n\n{"name":"jq","cmd":"jq .","desc":"JSON"}';
        expect(parseTools(raw)).toHaveLength(2);
    });

    test("skips malformed lines among good lines", () => {
        const raw =
            '{"name":"rg","cmd":"rg <pattern>","desc":"Fast search"}\nnot-json-at-all\n{"name":"jq","cmd":"jq .","desc":"JSON"}';
        const tools = parseTools(raw);
        expect(tools).toHaveLength(2);
        expect(tools.map((t) => t.name)).toEqual(["rg", "jq"]);
    });

    test("skips object missing required fields", () => {
        const raw = '{"name":"rg","cmd":"rg <pattern>"}\n{"name":"jq","cmd":"jq .","desc":"JSON"}';
        const tools = parseTools(raw);
        expect(tools).toHaveLength(1);
        expect(tools[0].name).toBe("jq");
    });

    test("empty string returns empty array", () => {
        expect(parseTools("")).toHaveLength(0);
    });
});

// --- renderToolsTable ---

describe("renderToolsTable", () => {
    test("renders markdown table with header and rows", () => {
        const tools = [{ name: "rg", cmd: "rg <pattern>", desc: "Fast search" }];
        const output = renderToolsTable(tools);
        expect(output).toContain("| Tool | Usage | Description |");
        expect(output).toContain("|---|---|---|");
        expect(output).toContain("| `rg` | `rg <pattern>` | Fast search |");
    });
});

// --- renderScriptingAlternatives ---

describe("renderScriptingAlternatives", () => {
    test("renders use-bun heading and bullet per entry", () => {
        const entries = [{ name: "python", message: "use `bun -e '<code>'` for inline scripts or `bun run <file.ts>`" }];
        const output = renderScriptingAlternatives(entries);
        expect(output).toContain("**Scripting runtimes not available — use bun:**");
        expect(output).toContain("- `python`: use `bun -e '<code>'`");
    });

    test("renders multiple entries as separate bullets", () => {
        const entries = [
            { name: "python", message: "msg1" },
            { name: "node", message: "msg2" },
        ];
        const output = renderScriptingAlternatives(entries);
        expect(output).toContain("- `python`: msg1");
        expect(output).toContain("- `node`: msg2");
    });
});

// --- renderConstrainedPresent ---

describe("renderConstrainedPresent", () => {
    test("renders do-not-use heading and bullet per entry", () => {
        const entries = [{ name: "su", message: "privilege escalation is disabled by container security policy" }];
        const output = renderConstrainedPresent(entries);
        expect(output).toContain("**Do not use — blocked by container:**");
        expect(output).toContain("- `su`: privilege escalation is disabled");
    });

    test("renders multiple entries as separate bullets", () => {
        const entries = [
            { name: "sudo", message: "msg-sudo" },
            { name: "apt", message: "msg-apt" },
        ];
        const output = renderConstrainedPresent(entries);
        expect(output).toContain("- `sudo`: msg-sudo");
        expect(output).toContain("- `apt`: msg-apt");
    });
});

// --- renderAbsent ---

describe("renderAbsent", () => {
    test("renders compact not-available line with backtick-quoted names", () => {
        const output = renderAbsent(["docker", "python", "node"]);
        expect(output).toBe("**Not available:** `docker`, `python`, `node`");
    });

    test("renders single name correctly", () => {
        const output = renderAbsent(["docker"]);
        expect(output).toBe("**Not available:** `docker`");
    });
});

// --- render ---

describe("render", () => {
    const singleTool = [{ name: "rg", cmd: "rg <pattern>", desc: "Fast search" }];

    test("nothing — returns FALLBACK", () => {
        const output = render([], [], [], []);
        expect(output).toBe(FALLBACK);
    });

    test("tools only — returns heading and tools table", () => {
        const output = render(singleTool, [], [], []);
        expect(output).toContain("## Container shell tools");
        expect(output).toContain("| `rg`");
        expect(output).not.toContain("not available");
        expect(output).not.toContain("use bun");
    });

    test("scripting alternatives present — includes use-bun section", () => {
        const sa = [{ name: "python", message: "use bun" }];
        const output = render(singleTool, sa, [], []);
        expect(output).toContain("## Container shell tools");
        expect(output).toContain("| `rg`");
        expect(output).toContain("**Scripting runtimes not available — use bun:**");
        expect(output).toContain("- `python`: use bun");
    });

    test("constrained present — includes do-not-use section", () => {
        const cp = [{ name: "su", message: "privilege escalation is disabled by container security policy" }];
        const output = render(singleTool, [], cp, []);
        expect(output).toContain("## Container shell tools");
        expect(output).toContain("**Do not use — blocked by container:**");
        expect(output).toContain("- `su`:");
    });

    test("absent names — includes compact not-available line", () => {
        const output = render(singleTool, [], [], ["docker"]);
        expect(output).toContain("## Container shell tools");
        expect(output).toContain("**Not available:** `docker`");
    });

    test("sections are omitted when empty", () => {
        const output = render(singleTool, [], [], []);
        expect(output).not.toContain("use bun");
        expect(output).not.toContain("Do not use");
        expect(output).not.toContain("Not available");
    });

    test("heading always present when at least one input is non-empty", () => {
        expect(render(singleTool, [], [], [])).toContain("## Container shell tools");
        expect(render([], [{ name: "python", message: "msg" }], [], [])).toContain("## Container shell tools");
        expect(render([], [], [{ name: "su", message: "msg" }], [])).toContain("## Container shell tools");
        expect(render([], [], [], ["docker"])).toContain("## Container shell tools");
    });
});

// --- RenderAddaShellTools (execute via run) ---

describe("RenderAddaShellTools", () => {
    test("scripting alternatives — bun in tools, python absent — renders use-bun section", async () => {
        const jsonl = '{"name":"bun","cmd":"bun run <file>","desc":"Scripting"}';
        // python absent (exit 1), everything else present
        const { deps, outLines } = makeMockDeps({
            fileContent: jsonl,
            whichResults: { ...allPresent(), python: 1 },
        });
        const code = await new RenderAddaShellTools(deps).run(["bun", "render-adda-shell-tools.ts"]);
        expect(code).toBe(0);
        const out = outLines.join("");
        expect(out).toContain("**Scripting runtimes not available — use bun:**");
        expect(out).toContain("- `python`:");
        expect(out).not.toContain("**Not available:** `python`");
    });

    test("scripting absent grouped — bun not in tools, python+node absent — compact not-available line", async () => {
        // No bun in tools table, python and node absent
        const jsonl = '{"name":"rg","cmd":"rg <pattern>","desc":"Fast search"}';
        const { deps, outLines } = makeMockDeps({
            fileContent: jsonl,
            whichResults: { ...allPresent(), python: 1, node: 1 },
        });
        const code = await new RenderAddaShellTools(deps).run(["bun", "render-adda-shell-tools.ts"]);
        expect(code).toBe(0);
        const out = outLines.join("");
        expect(out).not.toContain("**Scripting runtimes not available — use bun:**");
        expect(out).toContain("**Not available:**");
        expect(out).toContain("`python`");
        expect(out).toContain("`node`");
    });

    test("constrained present — su present — renders do-not-use section", async () => {
        const jsonl = '{"name":"rg","cmd":"rg <pattern>","desc":"Fast search"}';
        // su present (0), everything else absent (1) for constrained probes
        const { deps, outLines } = makeMockDeps({
            fileContent: jsonl,
            whichResults: { ...allAbsent(), su: 0 },
        });
        const code = await new RenderAddaShellTools(deps).run(["bun", "render-adda-shell-tools.ts"]);
        expect(code).toBe(0);
        const out = outLines.join("");
        expect(out).toContain("**Do not use — blocked by container:**");
        expect(out).toContain("- `su`:");
        expect(out).toContain("privilege escalation is disabled by container security policy");
    });

    test("constrained absent — docker absent — compact not-available line includes docker", async () => {
        const jsonl = '{"name":"bun","cmd":"bun run <file>","desc":"Scripting"}';
        // docker absent, everything else present
        const { deps, outLines } = makeMockDeps({
            fileContent: jsonl,
            whichResults: { ...allPresent(), docker: 1 },
        });
        const code = await new RenderAddaShellTools(deps).run(["bun", "render-adda-shell-tools.ts"]);
        expect(code).toBe(0);
        const out = outLines.join("");
        expect(out).toContain("**Not available:**");
        expect(out).toContain("`docker`");
    });

    test("nominal container — bun+tools present, python/node absent, su/sudo/apt present, docker absent — all sections", async () => {
        const jsonl =
            '{"name":"bun","cmd":"bun run <file>","desc":"Scripting"}\n{"name":"rg","cmd":"rg <pattern>","desc":"Fast search"}';
        const { deps, outLines } = makeMockDeps({
            fileContent: jsonl,
            whichResults: {
                // scripting probes: python, node absent; python3, pip, npm present
                python: 1,
                python3: 0,
                node: 1,
                pip: 0,
                npm: 0,
                // constrained probes: su, sudo, apt present; docker absent
                su: 0,
                sudo: 0,
                apt: 0,
                docker: 1,
            },
        });
        const code = await new RenderAddaShellTools(deps).run(["bun", "render-adda-shell-tools.ts"]);
        expect(code).toBe(0);
        const out = outLines.join("");
        // tools table
        expect(out).toContain("| `bun`");
        expect(out).toContain("| `rg`");
        // use-bun section for absent scripting tools
        expect(out).toContain("**Scripting runtimes not available — use bun:**");
        expect(out).toContain("- `python`:");
        expect(out).toContain("- `node`:");
        // do-not-use section for present constrained tools
        expect(out).toContain("**Do not use — blocked by container:**");
        expect(out).toContain("- `su`:");
        expect(out).toContain("- `sudo`:");
        expect(out).toContain("- `apt`:");
        // compact absent line for docker
        expect(out).toContain("**Not available:** `docker`");
    });

    test("FALLBACK constant has expected value", () => {
        // FALLBACK is unreachable via execute() in practice: absent constrained probes always
        // populate allAbsent, and present constrained probes populate constrainedPresent.
        // The pure render() FALLBACK path is covered by the render() describe block above.
        // This test simply guards the constant value itself.
        expect(FALLBACK).toBe("No shell tool information is available for this container.");
    });

    test("silent scripting — bun in tools, python present — no scripting section in output", async () => {
        const jsonl = '{"name":"bun","cmd":"bun run <file>","desc":"Scripting"}';
        const { deps, outLines } = makeMockDeps({
            fileContent: jsonl,
            whichResults: allPresent(),
        });
        const code = await new RenderAddaShellTools(deps).run(["bun", "render-adda-shell-tools.ts"]);
        expect(code).toBe(0);
        const out = outLines.join("");
        expect(out).not.toContain("**Scripting runtimes not available");
    });

    test("renders tools table and absent section when both are present", async () => {
        const jsonl = '{"name":"rg","cmd":"rg <pattern>","desc":"Fast search"}';
        const { deps, outLines } = makeMockDeps({
            fileContent: jsonl,
            whichResults: { ...allAbsent(), ...Object.fromEntries(Object.keys(CONSTRAINED_PROBES).map((k) => [k, 0])) },
        });
        const code = await new RenderAddaShellTools(deps).run(["bun", "render-adda-shell-tools.ts"]);
        expect(code).toBe(0);
        const out = outLines.join("");
        expect(out).toContain("| `rg`");
        // scripting absent (no bun in tools) → compact line
        expect(out).toContain("**Not available:**");
    });

    test("skips malformed lines in JSONL and renders valid entries", async () => {
        const jsonl =
            '{"name":"rg","cmd":"rg <pattern>","desc":"Fast search"}\nbad-line\n{"name":"jq","cmd":"jq .","desc":"JSON"}';
        const { deps, outLines } = makeMockDeps({
            fileContent: jsonl,
            whichResults: allPresent(),
        });
        const code = await new RenderAddaShellTools(deps).run(["bun", "render-adda-shell-tools.ts"]);
        expect(code).toBe(0);
        const out = outLines.join("");
        expect(out).toContain("| `rg`");
        expect(out).toContain("| `jq`");
    });
});
