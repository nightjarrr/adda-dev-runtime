import { describe, expect, mock, test } from "bun:test";
import { ScriptShellError } from "../lib/errors";
import type {
    FileReader,
    FileReaderDep,
    FileWriter,
    FileWriterDep,
    Shell,
    ShellDep,
    ShellResult,
    StdioDep,
    Tmp,
    TmpDep,
} from "../lib/index";
import { QualityGatesScript } from "./quality-gates";

type QualityGatesDeps = ShellDep & FileReaderDep & FileWriterDep & TmpDep & StdioDep;

// --- Mock helpers ---

const FAKE_REPO_ROOT = "/fake/repo";
const FAKE_RESULT_PATH = "/tmp/quality-gates-test.json";

function makeGitSuccessResult(): ShellResult {
    return { stdout: `${FAKE_REPO_ROOT}\n`, stderr: "", exitCode: 0 };
}

function makeShellSuccess(stdout = "", stderr = ""): ShellResult {
    return { stdout, stderr, exitCode: 0 };
}

function makeShellFailure(stdout = "", stderr = ""): ShellResult {
    return { stdout, stderr, exitCode: 1 };
}

// --- TOML fixture helpers ---

function makeTomlGate(name: string, description: string, command: string): string {
    return `[[gate]]\nname = "${name}"\ndescription = "${description}"\ncommand = "${command}"\n`;
}

function makeSingleGateToml(name = "my-gate", description = "My gate description", command = "my-cmd"): string {
    return makeTomlGate(name, description, command);
}

function makeTwoGateToml(): string {
    return makeTomlGate("gate-a", "Gate A description", "cmd-a") + "\n" + makeTomlGate("gate-b", "Gate B description", "cmd-b");
}

function makeThreeGateToml(): string {
    return (
        makeTomlGate("gate-pass", "Pass gate", "cmd-pass") +
        "\n" +
        makeTomlGate("gate-fail", "Fail gate", "cmd-fail") +
        "\n" +
        makeTomlGate("gate-pass2", "Pass gate 2", "cmd-pass2")
    );
}

interface MockDepsOptions {
    gitResult?: ShellResult;
    runShResults?: ShellResult[];
    confContent?: string | Error;
}

function makeMockDeps(options: MockDepsOptions = {}): {
    deps: QualityGatesDeps;
    outLines: string[];
    errLines: string[];
    writtenFiles: Map<string, string>;
} {
    const outLines: string[] = [];
    const errLines: string[] = [];
    const writtenFiles = new Map<string, string>();

    const gitResult = options.gitResult ?? makeGitSuccessResult();
    const runShResults = options.runShResults ?? [];
    let runShCallCount = 0;

    const mockShell: Shell = {
        run: mock(async (_command: string[], opts?: { strict?: boolean }): Promise<ShellResult> => {
            if ((opts?.strict ?? true) && gitResult.exitCode !== 0) {
                throw new ScriptShellError(_command.join(" "), gitResult.exitCode, gitResult.stdout, gitResult.stderr);
            }
            return gitResult;
        }),
        runSh: mock(async (_command: string, _opts?: { strict?: boolean }): Promise<ShellResult> => {
            const result = runShResults[runShCallCount] ?? makeShellSuccess();
            runShCallCount++;
            return result;
        }),
    };

    const mockFileReader: FileReader = {
        readFile: mock(async (path: string): Promise<string> => {
            if (options.confContent instanceof Error) throw options.confContent;
            if (options.confContent !== undefined) return options.confContent;
            throw new Error(`File not found: ${path}`);
        }),
    };

    const mockFileWriter: FileWriter = {
        writeFile: mock(async (path: string, content: string): Promise<void> => {
            writtenFiles.set(path, content);
        }),
        atomicWriteFile: mock(async (_pathPattern: string, _content: string): Promise<string> => FAKE_RESULT_PATH),
    };

    const mockTmp: Tmp = {
        tempFilePath: mock((): string => FAKE_RESULT_PATH),
        makeTempDir: mock((): string => "/tmp/fake-dir"),
        tmpDir: mock((): string => "/tmp"),
    };

    const deps: QualityGatesDeps = {
        shell: mockShell,
        fileReader: mockFileReader,
        fileWriter: mockFileWriter,
        tmp: mockTmp,
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

    return { deps, outLines, errLines, writtenFiles };
}

function readWrittenJson(writtenFiles: Map<string, string>): ReturnType<typeof JSON.parse> {
    const content = writtenFiles.get(FAKE_RESULT_PATH);
    if (!content) throw new Error("No JSON written to result path");
    return JSON.parse(content) as ReturnType<typeof JSON.parse>;
}

// --- Tests ---

describe("QualityGatesScript", () => {
    describe("git failure", () => {
        test("git rev-parse non-zero — exits 1", async () => {
            const { deps } = makeMockDeps({
                gitResult: { stdout: "", stderr: "not a git repo", exitCode: 128 },
            });
            const script = new QualityGatesScript(deps);
            const code = await script.run(["bun", "quality-gates.ts"]);
            expect(code).toBe(1);
        });

        test("git rev-parse non-zero — writes error to stderr", async () => {
            const { deps, errLines } = makeMockDeps({
                gitResult: { stdout: "", stderr: "not a git repo", exitCode: 128 },
            });
            const script = new QualityGatesScript(deps);
            await script.run(["bun", "quality-gates.ts"]);
            expect(errLines.join("")).toContain("Error:");
        });
    });

    describe("conf not found", () => {
        test("readFile throws — exits 2", async () => {
            const { deps } = makeMockDeps({
                confContent: new Error("ENOENT"),
            });
            const script = new QualityGatesScript(deps);
            const code = await script.run(["bun", "quality-gates.ts"]);
            expect(code).toBe(2);
        });

        test("readFile throws — stderr contains 'Config error:'", async () => {
            const { deps, errLines } = makeMockDeps({
                confContent: new Error("ENOENT"),
            });
            const script = new QualityGatesScript(deps);
            await script.run(["bun", "quality-gates.ts"]);
            expect(errLines.join("")).toContain("Config error:");
        });
    });

    describe("invalid TOML syntax", () => {
        test("invalid TOML — exits 2", async () => {
            const { deps } = makeMockDeps({
                confContent: "= invalid key assignment\n",
            });
            const script = new QualityGatesScript(deps);
            const code = await script.run(["bun", "quality-gates.ts"]);
            expect(code).toBe(2);
        });

        test("invalid TOML — stderr contains 'Config error:'", async () => {
            const { deps, errLines } = makeMockDeps({
                confContent: "= invalid key assignment\n",
            });
            const script = new QualityGatesScript(deps);
            await script.run(["bun", "quality-gates.ts"]);
            expect(errLines.join("")).toContain("Config error:");
        });
    });

    describe("missing required fields", () => {
        test("gate entry missing name field — exits 2", async () => {
            const { deps } = makeMockDeps({
                confContent: '[[gate]]\ndescription = "desc"\ncommand = "cmd"\n',
            });
            const script = new QualityGatesScript(deps);
            const code = await script.run(["bun", "quality-gates.ts"]);
            expect(code).toBe(2);
        });

        test("gate entry missing name field — stderr contains 'Config error:'", async () => {
            const { deps, errLines } = makeMockDeps({
                confContent: '[[gate]]\ndescription = "desc"\ncommand = "cmd"\n',
            });
            const script = new QualityGatesScript(deps);
            await script.run(["bun", "quality-gates.ts"]);
            expect(errLines.join("")).toContain("Config error:");
        });

        test("gate entry missing description field — exits 2", async () => {
            const { deps } = makeMockDeps({
                confContent: '[[gate]]\nname = "my-gate"\ncommand = "cmd"\n',
            });
            const script = new QualityGatesScript(deps);
            const code = await script.run(["bun", "quality-gates.ts"]);
            expect(code).toBe(2);
        });

        test("gate entry missing command field — exits 2", async () => {
            const { deps } = makeMockDeps({
                confContent: '[[gate]]\nname = "my-gate"\ndescription = "desc"\n',
            });
            const script = new QualityGatesScript(deps);
            const code = await script.run(["bun", "quality-gates.ts"]);
            expect(code).toBe(2);
        });
    });

    describe("empty or absent gate array", () => {
        test("gate key absent — exits 2", async () => {
            const { deps } = makeMockDeps({
                confContent: '[other]\nkey = "value"\n',
            });
            const script = new QualityGatesScript(deps);
            const code = await script.run(["bun", "quality-gates.ts"]);
            expect(code).toBe(2);
        });

        test("gate key absent — stderr contains 'Config error:'", async () => {
            const { deps, errLines } = makeMockDeps({
                confContent: '[other]\nkey = "value"\n',
            });
            const script = new QualityGatesScript(deps);
            await script.run(["bun", "quality-gates.ts"]);
            expect(errLines.join("")).toContain("Config error:");
        });
    });

    describe("conf parsing", () => {
        test("two gates are both executed", async () => {
            const { deps } = makeMockDeps({
                confContent: makeTwoGateToml(),
                runShResults: [makeShellSuccess(), makeShellSuccess()],
            });
            const script = new QualityGatesScript(deps);
            const code = await script.run(["bun", "quality-gates.ts"]);
            expect(code).toBe(0);
            const stdout = deps.stdio.stdout.write as ReturnType<typeof mock>;
            const calls = stdout.mock.calls.map((c: string[]) => c[0]);
            expect(calls.filter((l: string) => l.startsWith("[")).length).toBe(2);
        });

        test("gates are preserved in order", async () => {
            const { deps, writtenFiles } = makeMockDeps({
                confContent: makeTwoGateToml(),
                runShResults: [makeShellSuccess(), makeShellSuccess()],
            });
            const script = new QualityGatesScript(deps);
            await script.run(["bun", "quality-gates.ts"]);
            const result = readWrittenJson(writtenFiles);
            expect(result.gates[0].name).toBe("gate-a");
            expect(result.gates[1].name).toBe("gate-b");
        });

        test("gates carry correct name and description in result JSON", async () => {
            const { deps, writtenFiles } = makeMockDeps({
                confContent: makeSingleGateToml("my-gate", "My gate description", "my-cmd"),
                runShResults: [makeShellSuccess()],
            });
            const script = new QualityGatesScript(deps);
            await script.run(["bun", "quality-gates.ts"]);
            const result = readWrittenJson(writtenFiles);
            expect(result.gates[0].name).toBe("my-gate");
            expect(result.gates[0].description).toBe("My gate description");
        });
    });

    describe("all gates pass", () => {
        test("exits 0", async () => {
            const { deps } = makeMockDeps({
                confContent: makeTwoGateToml(),
                runShResults: [makeShellSuccess(), makeShellSuccess()],
            });
            const script = new QualityGatesScript(deps);
            const code = await script.run(["bun", "quality-gates.ts"]);
            expect(code).toBe(0);
        });

        test("stdout has [1/N] name — description progress line", async () => {
            const { deps, outLines } = makeMockDeps({
                confContent: makeTwoGateToml(),
                runShResults: [makeShellSuccess(), makeShellSuccess()],
            });
            const script = new QualityGatesScript(deps);
            await script.run(["bun", "quality-gates.ts"]);
            const joined = outLines.join("");
            expect(joined).toContain("[1/2] gate-a — Gate A description");
            expect(joined).toContain("[2/2] gate-b — Gate B description");
        });

        test("stdout has PASS after each gate", async () => {
            const { deps, outLines } = makeMockDeps({
                confContent: makeSingleGateToml(),
                runShResults: [makeShellSuccess()],
            });
            const script = new QualityGatesScript(deps);
            await script.run(["bun", "quality-gates.ts"]);
            const joined = outLines.join("");
            expect(joined).toContain("PASS");
        });

        test("stdout has === delimiter and overall PASS", async () => {
            const { deps, outLines } = makeMockDeps({
                confContent: makeSingleGateToml(),
                runShResults: [makeShellSuccess()],
            });
            const script = new QualityGatesScript(deps);
            await script.run(["bun", "quality-gates.ts"]);
            const joined = outLines.join("");
            expect(joined).toContain("===");
            expect(joined).toContain("PASS");
        });

        test("stdout has Results: line with result path", async () => {
            const { deps, outLines } = makeMockDeps({
                confContent: makeSingleGateToml(),
                runShResults: [makeShellSuccess()],
            });
            const script = new QualityGatesScript(deps);
            await script.run(["bun", "quality-gates.ts"]);
            const joined = outLines.join("");
            expect(joined).toContain(`Results: ${FAKE_RESULT_PATH}`);
        });

        test("JSON overall is PASS", async () => {
            const { deps, writtenFiles } = makeMockDeps({
                confContent: makeSingleGateToml(),
                runShResults: [makeShellSuccess()],
            });
            const script = new QualityGatesScript(deps);
            await script.run(["bun", "quality-gates.ts"]);
            const result = readWrittenJson(writtenFiles);
            expect(result.overall).toBe("PASS");
        });
    });

    describe("one gate fails", () => {
        test("exits 1", async () => {
            const { deps } = makeMockDeps({
                confContent: makeThreeGateToml(),
                runShResults: [makeShellSuccess(), makeShellFailure(), makeShellSuccess()],
            });
            const script = new QualityGatesScript(deps);
            const code = await script.run(["bun", "quality-gates.ts"]);
            expect(code).toBe(1);
        });

        test("stdout has FAIL", async () => {
            const { deps, outLines } = makeMockDeps({
                confContent: makeTwoGateToml(),
                runShResults: [makeShellSuccess(), makeShellFailure()],
            });
            const script = new QualityGatesScript(deps);
            await script.run(["bun", "quality-gates.ts"]);
            expect(outLines.join("")).toContain("FAIL");
        });

        test("all gates still run (run-all, no early exit)", async () => {
            const { deps } = makeMockDeps({
                confContent: makeThreeGateToml(),
                runShResults: [makeShellFailure(), makeShellSuccess(), makeShellSuccess()],
            });
            const script = new QualityGatesScript(deps);
            await script.run(["bun", "quality-gates.ts"]);
            const runSh = deps.shell.runSh as ReturnType<typeof mock>;
            expect(runSh).toHaveBeenCalledTimes(3);
        });

        test("JSON overall is FAIL", async () => {
            const { deps, writtenFiles } = makeMockDeps({
                confContent: makeSingleGateToml(),
                runShResults: [makeShellFailure()],
            });
            const script = new QualityGatesScript(deps);
            await script.run(["bun", "quality-gates.ts"]);
            const result = readWrittenJson(writtenFiles);
            expect(result.overall).toBe("FAIL");
        });
    });

    describe("JSON output shape", () => {
        test("written JSON has correct overall, gates[].name, gates[].description, gates[].command, gates[].status", async () => {
            const { deps, writtenFiles } = makeMockDeps({
                confContent: makeSingleGateToml("my-gate", "My gate description", "my-cmd"),
                runShResults: [makeShellSuccess("cmd stdout", "cmd stderr")],
            });
            const script = new QualityGatesScript(deps);
            await script.run(["bun", "quality-gates.ts"]);
            const result = readWrittenJson(writtenFiles);
            expect(result.overall).toBe("PASS");
            expect(result.gates).toHaveLength(1);
            expect(result.gates[0].name).toBe("my-gate");
            expect(result.gates[0].description).toBe("My gate description");
            expect(result.gates[0].command).toBe("my-cmd");
            expect(result.gates[0].status).toBe("PASS");
        });

        test("JSON result has 'gates' key (not 'checks')", async () => {
            const { deps, writtenFiles } = makeMockDeps({
                confContent: makeSingleGateToml(),
                runShResults: [makeShellSuccess()],
            });
            const script = new QualityGatesScript(deps);
            await script.run(["bun", "quality-gates.ts"]);
            const result = readWrittenJson(writtenFiles);
            expect(result.gates).toBeDefined();
            expect(result.checks).toBeUndefined();
        });
    });

    describe("gate output captured", () => {
        test("stdout from runSh appears in gates[].output", async () => {
            const { deps, writtenFiles } = makeMockDeps({
                confContent: makeSingleGateToml(),
                runShResults: [makeShellSuccess("hello from stdout", "")],
            });
            const script = new QualityGatesScript(deps);
            await script.run(["bun", "quality-gates.ts"]);
            const result = readWrittenJson(writtenFiles);
            expect(result.gates[0].output).toContain("hello from stdout");
        });

        test("stderr from runSh appears in gates[].output (merged via 2>&1 in shell)", async () => {
            const { deps, writtenFiles } = makeMockDeps({
                confContent: makeSingleGateToml(),
                runShResults: [makeShellFailure("error on stderr", "")],
            });
            const script = new QualityGatesScript(deps);
            await script.run(["bun", "quality-gates.ts"]);
            const result = readWrittenJson(writtenFiles);
            expect(result.gates[0].output).toContain("error on stderr");
        });

        test("output is result.stdout only (streams merged at shell level via 2>&1)", async () => {
            const { deps, writtenFiles } = makeMockDeps({
                confContent: makeSingleGateToml(),
                runShResults: [makeShellSuccess("out-part", "")],
            });
            const script = new QualityGatesScript(deps);
            await script.run(["bun", "quality-gates.ts"]);
            const result = readWrittenJson(writtenFiles);
            expect(result.gates[0].output).toBe("out-part");
        });
    });
});
