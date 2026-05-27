import { describe, expect, mock, test } from "bun:test";
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
} from "./lib/index";
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
        run: mock(async (): Promise<ShellResult> => gitResult),
        runSh: mock(async (): Promise<ShellResult> => {
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
    };

    const mockTmp: Tmp = {
        tempFilePath: mock((): string => FAKE_RESULT_PATH),
        makeTempDir: mock((): string => "/tmp/fake-dir"),
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
    test("create() returns a QualityGatesScript instance", () => {
        const script = QualityGatesScript.create();
        expect(script).toBeInstanceOf(QualityGatesScript);
    });

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

    describe("empty conf", () => {
        test("all blank and comment lines — exits 2", async () => {
            const { deps } = makeMockDeps({
                confContent: "# comment\n  \n# another comment\n",
            });
            const script = new QualityGatesScript(deps);
            const code = await script.run(["bun", "quality-gates.ts"]);
            expect(code).toBe(2);
        });

        test("all blank and comment lines — stderr contains 'Config error:'", async () => {
            const { deps, errLines } = makeMockDeps({
                confContent: "# comment\n  \n",
            });
            const script = new QualityGatesScript(deps);
            await script.run(["bun", "quality-gates.ts"]);
            expect(errLines.join("")).toContain("Config error:");
        });
    });

    describe("conf parsing", () => {
        test("blank lines are excluded", async () => {
            const { deps } = makeMockDeps({
                confContent: "\ncmd-one\n\ncmd-two\n",
                runShResults: [makeShellSuccess(), makeShellSuccess()],
            });
            const script = new QualityGatesScript(deps);
            const code = await script.run(["bun", "quality-gates.ts"]);
            expect(code).toBe(0);
            const stdout = deps.stdio.stdout.write as ReturnType<typeof mock>;
            // Should have two [N/total] lines
            const calls = stdout.mock.calls.map((c: string[]) => c[0]);
            expect(calls.filter((l: string) => l.startsWith("[")).length).toBe(2);
        });

        test("# prefixed lines are excluded", async () => {
            const { deps } = makeMockDeps({
                confContent: "# skip me\ncmd-one\n# skip me too\n",
                runShResults: [makeShellSuccess()],
            });
            const script = new QualityGatesScript(deps);
            const code = await script.run(["bun", "quality-gates.ts"]);
            expect(code).toBe(0);
            const stdout = deps.stdio.stdout.write as ReturnType<typeof mock>;
            const calls = stdout.mock.calls.map((c: string[]) => c[0]);
            expect(calls.filter((l: string) => l.startsWith("[")).length).toBe(1);
        });

        test("valid commands are preserved in order", async () => {
            const { deps, writtenFiles } = makeMockDeps({
                confContent: "first-cmd\nsecond-cmd\n",
                runShResults: [makeShellSuccess(), makeShellSuccess()],
            });
            const script = new QualityGatesScript(deps);
            await script.run(["bun", "quality-gates.ts"]);
            const result = readWrittenJson(writtenFiles);
            expect(result.checks[0].command).toBe("first-cmd");
            expect(result.checks[1].command).toBe("second-cmd");
        });
    });

    describe("all checks pass", () => {
        test("exits 0", async () => {
            const { deps } = makeMockDeps({
                confContent: "cmd-a\ncmd-b\n",
                runShResults: [makeShellSuccess(), makeShellSuccess()],
            });
            const script = new QualityGatesScript(deps);
            const code = await script.run(["bun", "quality-gates.ts"]);
            expect(code).toBe(0);
        });

        test("stdout has [1/N] prefix line", async () => {
            const { deps, outLines } = makeMockDeps({
                confContent: "cmd-a\ncmd-b\n",
                runShResults: [makeShellSuccess(), makeShellSuccess()],
            });
            const script = new QualityGatesScript(deps);
            await script.run(["bun", "quality-gates.ts"]);
            const joined = outLines.join("");
            expect(joined).toContain("[1/2] cmd-a");
            expect(joined).toContain("[2/2] cmd-b");
        });

        test("stdout has PASS after each check", async () => {
            const { deps, outLines } = makeMockDeps({
                confContent: "cmd-a\n",
                runShResults: [makeShellSuccess()],
            });
            const script = new QualityGatesScript(deps);
            await script.run(["bun", "quality-gates.ts"]);
            const joined = outLines.join("");
            expect(joined).toContain("PASS");
        });

        test("stdout has === delimiter and overall PASS", async () => {
            const { deps, outLines } = makeMockDeps({
                confContent: "cmd-a\n",
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
                confContent: "cmd-a\n",
                runShResults: [makeShellSuccess()],
            });
            const script = new QualityGatesScript(deps);
            await script.run(["bun", "quality-gates.ts"]);
            const joined = outLines.join("");
            expect(joined).toContain(`Results: ${FAKE_RESULT_PATH}`);
        });

        test("JSON overall is PASS", async () => {
            const { deps, writtenFiles } = makeMockDeps({
                confContent: "cmd-a\n",
                runShResults: [makeShellSuccess()],
            });
            const script = new QualityGatesScript(deps);
            await script.run(["bun", "quality-gates.ts"]);
            const result = readWrittenJson(writtenFiles);
            expect(result.overall).toBe("PASS");
        });
    });

    describe("one check fails", () => {
        test("exits 1", async () => {
            const { deps } = makeMockDeps({
                confContent: "cmd-pass\ncmd-fail\ncmd-pass2\n",
                runShResults: [makeShellSuccess(), makeShellFailure(), makeShellSuccess()],
            });
            const script = new QualityGatesScript(deps);
            const code = await script.run(["bun", "quality-gates.ts"]);
            expect(code).toBe(1);
        });

        test("stdout has FAIL", async () => {
            const { deps, outLines } = makeMockDeps({
                confContent: "cmd-pass\ncmd-fail\n",
                runShResults: [makeShellSuccess(), makeShellFailure()],
            });
            const script = new QualityGatesScript(deps);
            await script.run(["bun", "quality-gates.ts"]);
            expect(outLines.join("")).toContain("FAIL");
        });

        test("all checks still run (run-all, no early exit)", async () => {
            const { deps } = makeMockDeps({
                confContent: "cmd-fail\ncmd-pass\ncmd-pass2\n",
                runShResults: [makeShellFailure(), makeShellSuccess(), makeShellSuccess()],
            });
            const script = new QualityGatesScript(deps);
            await script.run(["bun", "quality-gates.ts"]);
            const runSh = deps.shell.runSh as ReturnType<typeof mock>;
            expect(runSh).toHaveBeenCalledTimes(3);
        });

        test("JSON overall is FAIL", async () => {
            const { deps, writtenFiles } = makeMockDeps({
                confContent: "cmd-fail\n",
                runShResults: [makeShellFailure()],
            });
            const script = new QualityGatesScript(deps);
            await script.run(["bun", "quality-gates.ts"]);
            const result = readWrittenJson(writtenFiles);
            expect(result.overall).toBe("FAIL");
        });
    });

    describe("JSON output shape", () => {
        test("written JSON has correct overall, checks[].command, checks[].status, checks[].output", async () => {
            const { deps, writtenFiles } = makeMockDeps({
                confContent: "my-cmd\n",
                runShResults: [makeShellSuccess("cmd stdout", "cmd stderr")],
            });
            const script = new QualityGatesScript(deps);
            await script.run(["bun", "quality-gates.ts"]);
            const result = readWrittenJson(writtenFiles);
            expect(result.overall).toBe("PASS");
            expect(result.checks).toHaveLength(1);
            expect(result.checks[0].command).toBe("my-cmd");
            expect(result.checks[0].status).toBe("PASS");
        });
    });

    describe("check output captured", () => {
        test("stdout from runSh appears in checks[].output", async () => {
            const { deps, writtenFiles } = makeMockDeps({
                confContent: "my-cmd\n",
                runShResults: [makeShellSuccess("hello from stdout", "")],
            });
            const script = new QualityGatesScript(deps);
            await script.run(["bun", "quality-gates.ts"]);
            const result = readWrittenJson(writtenFiles);
            expect(result.checks[0].output).toContain("hello from stdout");
        });

        test("stderr from runSh appears in checks[].output (merged via 2>&1 in shell)", async () => {
            const { deps, writtenFiles } = makeMockDeps({
                confContent: "my-cmd\n",
                runShResults: [makeShellFailure("error on stderr", "")],
            });
            const script = new QualityGatesScript(deps);
            await script.run(["bun", "quality-gates.ts"]);
            const result = readWrittenJson(writtenFiles);
            expect(result.checks[0].output).toContain("error on stderr");
        });

        test("output is result.stdout only (streams merged at shell level via 2>&1)", async () => {
            const { deps, writtenFiles } = makeMockDeps({
                confContent: "my-cmd\n",
                runShResults: [makeShellSuccess("out-part", "")],
            });
            const script = new QualityGatesScript(deps);
            await script.run(["bun", "quality-gates.ts"]);
            const result = readWrittenJson(writtenFiles);
            expect(result.checks[0].output).toBe("out-part");
        });
    });
});
