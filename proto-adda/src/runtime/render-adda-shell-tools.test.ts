import { describe, expect, mock, test } from "bun:test";
import type { FileReader, FileReaderDep, FileWriter, FileWriterDep, Shell, ShellDep, ShellResult, StdioDep } from "@adda/lib";
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

type RenderAddaShellToolsDeps = FileReaderDep & FileWriterDep & ShellDep & StdioDep;

const FAKE_OUTPUT_PATH = "/tmp/test-shell-tools.md";

/**
 * All known probe names: used by tests that want a specific set to be present or absent.
 * Keys from both probe maps.
 */
const ALL_PROBE_NAMES = [...Object.keys(SCRIPTING_PROBES), ...Object.keys(CONSTRAINED_PROBES)];

function makeMockDeps(options: { fileContent?: string | Error; whichResults?: Record<string, number> }): {
    deps: RenderAddaShellToolsDeps;
    outLines: string[];
    errLines: string[];
    writtenContent: { value: string };
} {
    const outLines: string[] = [];
    const errLines: string[] = [];
    const writtenContent = { value: "" };

    const mockFileReader: FileReader = {
        readFile: mock(async (_path: string): Promise<string> => {
            if (options.fileContent instanceof Error) throw options.fileContent;
            return options.fileContent ?? "";
        }),
    };

    const mockFileWriter: FileWriter = {
        writeFile: mock(async (_pattern: string, content: string): Promise<string> => {
            writtenContent.value = content;
            return FAKE_OUTPUT_PATH;
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
        fileWriter: mockFileWriter,
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

    return { deps, outLines, errLines, writtenContent };
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
        const { tools } = parseTools(raw);
        expect(tools).toHaveLength(2);
        expect(tools[0]).toEqual({ name: "rg", cmd: "rg <pattern>", desc: "Fast search" });
        expect(tools[1]).toEqual({ name: "jq", cmd: "jq .", desc: "JSON" });
    });

    test("skips blank lines", () => {
        const raw = '{"name":"rg","cmd":"rg <pattern>","desc":"Fast search"}\n\n{"name":"jq","cmd":"jq .","desc":"JSON"}';
        const { tools } = parseTools(raw);
        expect(tools).toHaveLength(2);
    });

    test("skips malformed lines among good lines", () => {
        const raw =
            '{"name":"rg","cmd":"rg <pattern>","desc":"Fast search"}\nnot-json-at-all\n{"name":"jq","cmd":"jq .","desc":"JSON"}';
        const { tools } = parseTools(raw);
        expect(tools).toHaveLength(2);
        expect(tools.map((t) => t.name)).toEqual(["rg", "jq"]);
    });

    test("malformed line populates skippedLines, valid lines still parsed", () => {
        const raw =
            '{"name":"rg","cmd":"rg <pattern>","desc":"Fast search"}\nnot-json-at-all\n{"name":"jq","cmd":"jq .","desc":"JSON"}';
        const { tools, skippedLines } = parseTools(raw);
        expect(tools).toHaveLength(2);
        expect(skippedLines).toEqual(["not-json-at-all"]);
    });

    test("skips object missing required fields — populates skippedLines", () => {
        const raw = '{"name":"rg","cmd":"rg <pattern>"}\n{"name":"jq","cmd":"jq .","desc":"JSON"}';
        const { tools, skippedLines } = parseTools(raw);
        expect(tools).toHaveLength(1);
        expect(tools[0].name).toBe("jq");
        expect(skippedLines).toHaveLength(1);
    });

    test("empty string returns empty tools and no skipped lines", () => {
        const { tools, skippedLines } = parseTools("");
        expect(tools).toHaveLength(0);
        expect(skippedLines).toHaveLength(0);
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
    test("renders updated heading and bullet per entry", () => {
        const entries = [{ name: "python", message: "use `bun -e '<code>'` for inline scripts or `bun run <file.ts>`" }];
        const output = renderScriptingAlternatives(entries);
        expect(output).toContain(
            "**The following scripting runtimes are not available in this container — see the suggested alternative for each:**",
        );
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
    test("renders updated heading and bullet per entry", () => {
        const entries = [{ name: "su", message: "privilege escalation is disabled by container security policy" }];
        const output = renderConstrainedPresent(entries);
        expect(output).toContain("**The following tools will not work in this container environment:**");
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
    test("renders updated not-available line with backtick-quoted names and command not found note", () => {
        const output = renderAbsent(["docker", "python", "node"]);
        expect(output).toBe("**Not available** (calls will result in `command not found`): `docker`, `python`, `node`");
    });

    test("renders single name correctly", () => {
        const output = renderAbsent(["docker"]);
        expect(output).toBe("**Not available** (calls will result in `command not found`): `docker`");
    });
});

// --- render ---

describe("render", () => {
    const singleTool = [{ name: "rg", cmd: "rg <pattern>", desc: "Fast search" }];

    test("nothing — returns FALLBACK", () => {
        const output = render([], [], [], []);
        expect(output).toBe(FALLBACK);
    });

    test("tools only — returns intro sentence and tools table, no heading", () => {
        const output = render(singleTool, [], [], []);
        expect(output).not.toContain("## Container shell tools");
        expect(output).toContain("Use the following tools — they are available in this container:");
        expect(output).toContain("| `rg`");
        expect(output).not.toContain("not available");
        expect(output).not.toContain("use bun");
    });

    test("scripting alternatives present — includes scripting alternatives section, no heading", () => {
        const sa = [{ name: "python", message: "use bun" }];
        const output = render(singleTool, sa, [], []);
        expect(output).not.toContain("## Container shell tools");
        expect(output).toContain("| `rg`");
        expect(output).toContain(
            "**The following scripting runtimes are not available in this container — see the suggested alternative for each:**",
        );
        expect(output).toContain("- `python`: use bun");
    });

    test("constrained present — includes constrained tools section, no heading", () => {
        const cp = [{ name: "su", message: "privilege escalation is disabled by container security policy" }];
        const output = render(singleTool, [], cp, []);
        expect(output).not.toContain("## Container shell tools");
        expect(output).toContain("**The following tools will not work in this container environment:**");
        expect(output).toContain("- `su`:");
    });

    test("absent names — includes not-available line, no heading", () => {
        const output = render(singleTool, [], [], ["docker"]);
        expect(output).not.toContain("## Container shell tools");
        expect(output).toContain("**Not available** (calls will result in `command not found`): `docker`");
    });

    test("sections are omitted when empty", () => {
        const output = render(singleTool, [], [], []);
        expect(output).not.toContain("scripting runtimes");
        expect(output).not.toContain("will not work");
        expect(output).not.toContain("Not available");
    });

    test("heading never present regardless of inputs", () => {
        expect(render(singleTool, [], [], [])).not.toContain("## Container shell tools");
        expect(render([], [{ name: "python", message: "msg" }], [], [])).not.toContain("## Container shell tools");
        expect(render([], [], [{ name: "su", message: "msg" }], [])).not.toContain("## Container shell tools");
        expect(render([], [], [], ["docker"])).not.toContain("## Container shell tools");
    });

    test("intro sentence only rendered when tools are present", () => {
        const output = render([], [{ name: "python", message: "msg" }], [], []);
        expect(output).not.toContain("Use the following tools");
    });
});

// --- RenderAddaShellTools (execute via run) ---

describe("RenderAddaShellTools", () => {
    test("scripting alternatives — bun in tools, python absent — renders updated use-bun section", async () => {
        const jsonl = '{"name":"bun","cmd":"bun run <file>","desc":"Scripting"}';
        // python absent (exit 1), everything else present
        const { deps, outLines, writtenContent } = makeMockDeps({
            fileContent: jsonl,
            whichResults: { ...allPresent(), python: 1 },
        });
        const code = await new RenderAddaShellTools(deps).run([
            "bun",
            "render-adda-shell-tools.ts",
            "--output",
            FAKE_OUTPUT_PATH,
        ]);
        expect(code).toBe(0);
        expect(writtenContent.value).toContain(
            "**The following scripting runtimes are not available in this container — see the suggested alternative for each:**",
        );
        expect(writtenContent.value).toContain("- `python`:");
        expect(writtenContent.value).not.toContain("**Not available** (calls will result in `command not found`): `python`");
        const envelope = JSON.parse(outLines.join(""));
        expect(envelope).toMatchObject({ status: "ok", result: { path: FAKE_OUTPUT_PATH }, error: null });
    });

    test("scripting absent grouped — bun not in tools, python+node absent — updated compact not-available line", async () => {
        // No bun in tools table, python and node absent
        const jsonl = '{"name":"rg","cmd":"rg <pattern>","desc":"Fast search"}';
        const { deps, outLines, writtenContent } = makeMockDeps({
            fileContent: jsonl,
            whichResults: { ...allPresent(), python: 1, node: 1 },
        });
        const code = await new RenderAddaShellTools(deps).run([
            "bun",
            "render-adda-shell-tools.ts",
            "--output",
            FAKE_OUTPUT_PATH,
        ]);
        expect(code).toBe(0);
        expect(writtenContent.value).not.toContain("scripting runtimes are not available");
        expect(writtenContent.value).toContain("**Not available** (calls will result in `command not found`):");
        expect(writtenContent.value).toContain("`python`");
        expect(writtenContent.value).toContain("`node`");
        const envelope = JSON.parse(outLines.join(""));
        expect(envelope).toMatchObject({ status: "ok", result: { path: FAKE_OUTPUT_PATH }, error: null });
    });

    test("constrained present — su present — renders updated do-not-use section", async () => {
        const jsonl = '{"name":"rg","cmd":"rg <pattern>","desc":"Fast search"}';
        // su present (0), everything else absent (1) for constrained probes
        const { deps, outLines, writtenContent } = makeMockDeps({
            fileContent: jsonl,
            whichResults: { ...allAbsent(), su: 0 },
        });
        const code = await new RenderAddaShellTools(deps).run([
            "bun",
            "render-adda-shell-tools.ts",
            "--output",
            FAKE_OUTPUT_PATH,
        ]);
        expect(code).toBe(0);
        expect(writtenContent.value).toContain("**The following tools will not work in this container environment:**");
        expect(writtenContent.value).toContain("- `su`:");
        expect(writtenContent.value).toContain("privilege escalation is disabled by container security policy");
        const envelope = JSON.parse(outLines.join(""));
        expect(envelope).toMatchObject({ status: "ok", result: { path: FAKE_OUTPUT_PATH }, error: null });
    });

    test("constrained absent — docker absent — updated compact not-available line includes docker", async () => {
        const jsonl = '{"name":"bun","cmd":"bun run <file>","desc":"Scripting"}';
        // docker absent, everything else present
        const { deps, outLines, writtenContent } = makeMockDeps({
            fileContent: jsonl,
            whichResults: { ...allPresent(), docker: 1 },
        });
        const code = await new RenderAddaShellTools(deps).run([
            "bun",
            "render-adda-shell-tools.ts",
            "--output",
            FAKE_OUTPUT_PATH,
        ]);
        expect(code).toBe(0);
        expect(writtenContent.value).toContain("**Not available** (calls will result in `command not found`):");
        expect(writtenContent.value).toContain("`docker`");
        const envelope = JSON.parse(outLines.join(""));
        expect(envelope).toMatchObject({ status: "ok", result: { path: FAKE_OUTPUT_PATH }, error: null });
    });

    test("nominal container — bun+tools present, python/node absent, su/sudo/apt present, docker absent — all sections", async () => {
        const jsonl =
            '{"name":"bun","cmd":"bun run <file>","desc":"Scripting"}\n{"name":"rg","cmd":"rg <pattern>","desc":"Fast search"}';
        const { deps, outLines, writtenContent } = makeMockDeps({
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
        const code = await new RenderAddaShellTools(deps).run([
            "bun",
            "render-adda-shell-tools.ts",
            "--output",
            FAKE_OUTPUT_PATH,
        ]);
        expect(code).toBe(0);
        // tools table with intro
        expect(writtenContent.value).toContain("Use the following tools — they are available in this container:");
        expect(writtenContent.value).toContain("| `bun`");
        expect(writtenContent.value).toContain("| `rg`");
        // use-bun section for absent scripting tools
        expect(writtenContent.value).toContain(
            "**The following scripting runtimes are not available in this container — see the suggested alternative for each:**",
        );
        expect(writtenContent.value).toContain("- `python`:");
        expect(writtenContent.value).toContain("- `node`:");
        // do-not-use section for present constrained tools
        expect(writtenContent.value).toContain("**The following tools will not work in this container environment:**");
        expect(writtenContent.value).toContain("- `su`:");
        expect(writtenContent.value).toContain("- `sudo`:");
        expect(writtenContent.value).toContain("- `apt`:");
        // compact absent line for docker
        expect(writtenContent.value).toContain("**Not available** (calls will result in `command not found`): `docker`");
        const envelope = JSON.parse(outLines.join(""));
        expect(envelope).toMatchObject({ status: "ok", result: { path: FAKE_OUTPUT_PATH }, error: null });
    });

    test("FALLBACK constant has expected value", () => {
        expect(FALLBACK).toBe(
            "Warning: no shell tool information is available — the container may not have bootstrapped correctly. Use `which` <tool> to check whether a specific tool is present.",
        );
    });

    test("silent scripting — bun in tools, python present — no scripting section in output", async () => {
        const jsonl = '{"name":"bun","cmd":"bun run <file>","desc":"Scripting"}';
        const { deps, outLines, writtenContent } = makeMockDeps({
            fileContent: jsonl,
            whichResults: allPresent(),
        });
        const code = await new RenderAddaShellTools(deps).run([
            "bun",
            "render-adda-shell-tools.ts",
            "--output",
            FAKE_OUTPUT_PATH,
        ]);
        expect(code).toBe(0);
        expect(writtenContent.value).not.toContain("scripting runtimes are not available");
        const envelope = JSON.parse(outLines.join(""));
        expect(envelope).toMatchObject({ status: "ok", result: { path: FAKE_OUTPUT_PATH }, error: null });
    });

    test("renders tools table and absent section when both are present", async () => {
        const jsonl = '{"name":"rg","cmd":"rg <pattern>","desc":"Fast search"}';
        const { deps, outLines, writtenContent } = makeMockDeps({
            fileContent: jsonl,
            whichResults: { ...allAbsent(), ...Object.fromEntries(Object.keys(CONSTRAINED_PROBES).map((k) => [k, 0])) },
        });
        const code = await new RenderAddaShellTools(deps).run([
            "bun",
            "render-adda-shell-tools.ts",
            "--output",
            FAKE_OUTPUT_PATH,
        ]);
        expect(code).toBe(0);
        expect(writtenContent.value).toContain("| `rg`");
        // scripting absent (no bun in tools) → compact line
        expect(writtenContent.value).toContain("**Not available** (calls will result in `command not found`):");
        const envelope = JSON.parse(outLines.join(""));
        expect(envelope).toMatchObject({ status: "ok", result: { path: FAKE_OUTPUT_PATH }, error: null });
    });

    test("skips malformed lines in JSONL and renders valid entries", async () => {
        const jsonl =
            '{"name":"rg","cmd":"rg <pattern>","desc":"Fast search"}\nbad-line\n{"name":"jq","cmd":"jq .","desc":"JSON"}';
        const { deps, outLines, writtenContent } = makeMockDeps({
            fileContent: jsonl,
            whichResults: allPresent(),
        });
        const code = await new RenderAddaShellTools(deps).run([
            "bun",
            "render-adda-shell-tools.ts",
            "--output",
            FAKE_OUTPUT_PATH,
        ]);
        expect(code).toBe(0);
        expect(writtenContent.value).toContain("| `rg`");
        expect(writtenContent.value).toContain("| `jq`");
        const envelope = JSON.parse(outLines.join(""));
        expect(envelope).toMatchObject({ status: "ok", result: { path: FAKE_OUTPUT_PATH }, error: null });
    });

    test("readFile failure produces warning text in file", async () => {
        const { deps, outLines, writtenContent } = makeMockDeps({
            fileContent: new Error("ENOENT"),
            whichResults: allPresent(),
        });
        const code = await new RenderAddaShellTools(deps).run([
            "bun",
            "render-adda-shell-tools.ts",
            "--output",
            FAKE_OUTPUT_PATH,
        ]);
        expect(code).toBe(0);
        const expectedWarning =
            "Warning: /run/adda/.adda-shell-tools.jsonl could not be read — the container may not have bootstrapped correctly. If you encounter unexpected tool availability issues, consider mentioning this to PO.";
        expect(writtenContent.value).toContain(expectedWarning);
        const envelope = JSON.parse(outLines.join(""));
        expect(envelope).toMatchObject({ status: "ok", result: { path: FAKE_OUTPUT_PATH }, error: null });
    });

    test("malformed JSONL produces warning text in file", async () => {
        const jsonl =
            '{"name":"rg","cmd":"rg <pattern>","desc":"Fast search"}\nnot-valid-json\n{"name":"jq","cmd":"jq .","desc":"JSON"}';
        const { deps, outLines, writtenContent } = makeMockDeps({
            fileContent: jsonl,
            whichResults: allPresent(),
        });
        const code = await new RenderAddaShellTools(deps).run([
            "bun",
            "render-adda-shell-tools.ts",
            "--output",
            FAKE_OUTPUT_PATH,
        ]);
        expect(code).toBe(0);
        const expectedWarning =
            "Warning: some entries in /run/adda/.adda-shell-tools.jsonl were skipped due to malformed content. If tool availability seems incorrect, consider asking PO for guidance.";
        expect(writtenContent.value).toContain(expectedWarning);
        const envelope = JSON.parse(outLines.join(""));
        expect(envelope).toMatchObject({ status: "ok", result: { path: FAKE_OUTPUT_PATH }, error: null });
    });
});
