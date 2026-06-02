import { describe, expect, mock, test } from "bun:test";
import type { FileReader, FileReaderDep, Shell, ShellDep, ShellResult, StdioDep } from "@adda/lib";
import {
    FALLBACK,
    PROBE_HINT,
    parseTools,
    RenderAddaShellTools,
    render,
    renderMissingTools,
    renderToolsTable,
    TOOL_PROBES,
} from "./render-adda-shell-tools";

// --- Mock helpers ---

type RenderAddaShellToolsDeps = FileReaderDep & ShellDep & StdioDep;

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

// All tools present by default (exitCode 0)
function allPresent(): Record<string, number> {
    return Object.fromEntries(TOOL_PROBES.map((t) => [t, 0]));
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

// --- renderMissingTools ---

describe("renderMissingTools", () => {
    test("renders absent-tools section with not-available message for each", () => {
        const output = renderMissingTools(["python", "docker"]);
        expect(output).toContain("**Absent tools:**");
        expect(output).toContain("`python` is not available");
        expect(output).toContain("`docker` is not available");
    });
});

// --- render ---

describe("render", () => {
    const singleTool = [{ name: "rg", cmd: "rg <pattern>", desc: "Fast search" }];

    test("both sections — returns tools table followed by missing section", () => {
        const output = render(singleTool, ["python"]);
        expect(output).toContain("| `rg`");
        expect(output).toContain("`python` is not available");
        expect(output).not.toContain(PROBE_HINT);
    });

    test("tools only — returns tools table without missing section or probe hint", () => {
        const output = render(singleTool, []);
        expect(output).toContain("| `rg`");
        expect(output).not.toContain("not available");
        expect(output).not.toContain(PROBE_HINT);
    });

    test("missing only — returns missing section and probe hint", () => {
        const output = render([], ["python"]);
        expect(output).toContain("`python` is not available");
        expect(output).toContain(PROBE_HINT);
        expect(output).not.toContain("| Tool |");
    });

    test("nothing — returns FALLBACK", () => {
        const output = render([], []);
        expect(output).toBe(FALLBACK);
    });
});

// --- RenderAddaShellTools (execute via run) ---

describe("RenderAddaShellTools", () => {
    test("renders tools table and missing section when both are present", async () => {
        const jsonl = '{"name":"rg","cmd":"rg <pattern>","desc":"Fast search"}';
        const { deps, outLines } = makeMockDeps({
            fileContent: jsonl,
            whichResults: { ...allPresent(), python: 1 },
        });
        const code = await new RenderAddaShellTools(deps).run(["bun", "render-adda-shell-tools.ts"]);
        expect(code).toBe(0);
        const out = outLines.join("");
        expect(out).toContain("| `rg`");
        expect(out).toContain("`python` is not available");
    });

    test("renders tools table only when no tools are absent", async () => {
        const jsonl = '{"name":"rg","cmd":"rg <pattern>","desc":"Fast search"}';
        const { deps, outLines } = makeMockDeps({
            fileContent: jsonl,
            whichResults: allPresent(),
        });
        const code = await new RenderAddaShellTools(deps).run(["bun", "render-adda-shell-tools.ts"]);
        expect(code).toBe(0);
        const out = outLines.join("");
        expect(out).toContain("| `rg`");
        expect(out).not.toContain("not available");
    });

    test("renders missing section and probe hint when file is missing", async () => {
        const { deps, outLines } = makeMockDeps({
            fileContent: new Error("ENOENT: no such file"),
            whichResults: { ...allPresent(), python: 1 },
        });
        const code = await new RenderAddaShellTools(deps).run(["bun", "render-adda-shell-tools.ts"]);
        expect(code).toBe(0);
        const out = outLines.join("");
        expect(out).toContain("`python` is not available");
        expect(out).toContain(PROBE_HINT);
        expect(out).not.toContain("| Tool |");
    });

    test("renders FALLBACK when file is missing and no tools are absent", async () => {
        const { deps, outLines } = makeMockDeps({
            fileContent: new Error("ENOENT: no such file"),
            whichResults: allPresent(),
        });
        const code = await new RenderAddaShellTools(deps).run(["bun", "render-adda-shell-tools.ts"]);
        expect(code).toBe(0);
        expect(outLines.join("")).toContain(FALLBACK);
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

    test("missing message contains 'not available' for absent tool", async () => {
        const { deps, outLines } = makeMockDeps({
            fileContent: "",
            whichResults: { ...allPresent(), python3: 1 },
        });
        const code = await new RenderAddaShellTools(deps).run(["bun", "render-adda-shell-tools.ts"]);
        expect(code).toBe(0);
        const out = outLines.join("");
        expect(out).toContain("`python3` is not available");
    });
});
