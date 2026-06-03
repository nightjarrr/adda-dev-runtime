import { describe, expect, mock, test } from "bun:test";
import type {
    Env,
    EnvDep,
    FileSys,
    FileSysDep,
    FileReader,
    FileReaderDep,
    FileWriter,
    FileWriterDep,
    Shell,
    ShellDep,
    ShellResult,
    StdioDep,
} from "../lib/index";
import { CurrentIssueScript, type IssueStateStore } from "./current-issue";

type CurrentIssueDeps = ShellDep & EnvDep & StdioDep & FileWriterDep & FileReaderDep & FileSysDep;

// --- Helpers ---

function makeShellResult(overrides: Partial<ShellResult> = {}): ShellResult {
    return { stdout: "", stderr: "", exitCode: 0, ...overrides };
}

function makeGhIssueResponse(title = "Test issue", labels: string[] = ["feature"], state = "OPEN"): string {
    return JSON.stringify({
        title,
        labels: labels.map((name) => ({ name })),
        state,
    });
}

function makeResolveResponse(status: string, branch = "", pr = "", details = ""): string {
    return JSON.stringify({ status, branch, pr, details });
}

// --- Mock factory ---

interface MockDepsOptions {
    shellRun?: (command: string[]) => Promise<ShellResult>;
    envVars?: Record<string, string>;
    fileReaderReadFile?: (path: string) => Promise<string>;
    fileWriterWriteFile?: (path: string, content: string) => Promise<void>;
    fileSysRenameFile?: (from: string, to: string) => Promise<void>;
    fileSysDeleteFile?: (path: string) => Promise<void>;
}

function makeMockDeps(options: MockDepsOptions = {}): {
    deps: CurrentIssueDeps;
    outLines: string[];
    errLines: string[];
} {
    const outLines: string[] = [];
    const errLines: string[] = [];

    const defaultEnvVars: Record<string, string> = {
        GITHUB_OWNER: "testowner",
        GITHUB_REPO: "testrepo",
    };

    // Default shell: clean status, successful gh issue, successful resolve (feature_branch), successful checkout
    const defaultShellRun = async (command: string[]): Promise<ShellResult> => {
        const cmd = command[0];
        if (cmd === "git" && command[1] === "status") {
            return makeShellResult({ stdout: "" });
        }
        if (cmd === "gh") {
            return makeShellResult({ stdout: makeGhIssueResponse() });
        }
        if (cmd === "/usr/local/libexec/adda-dev-runtime/bin/resolve-issue-branch") {
            return makeShellResult({ stdout: makeResolveResponse("feature_branch", "feature/28-test-issue", "42") });
        }
        if (cmd === "git" && command[1] === "checkout") {
            return makeShellResult();
        }
        return makeShellResult();
    };

    const mockShell: Shell = {
        run: mock(options.shellRun ?? defaultShellRun),
        runSh: mock(async (_cmd: string) => makeShellResult()),
    };

    const envVars = options.envVars ?? defaultEnvVars;
    const mockEnv: Env = {
        get: mock((name: string) => envVars[name]),
    };

    const mockFileReader: FileReader = {
        readFile: mock(
            options.fileReaderReadFile ??
                (async (_path: string) => {
                    const enoent = Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
                    throw enoent;
                }),
        ),
    };

    const mockFileWriter: FileWriter = {
        writeFile: mock(options.fileWriterWriteFile ?? (async (_path: string, _content: string) => {})),
    };

    const mockFileSys: FileSys = {
        renameFile: mock(options.fileSysRenameFile ?? (async (_from: string, _to: string) => {})),
        deleteFile: mock(options.fileSysDeleteFile ?? (async (_path: string) => {})),
    };

    const deps: CurrentIssueDeps = {
        shell: mockShell,
        env: mockEnv,
        fileReader: mockFileReader,
        fileWriter: mockFileWriter,
        fileSys: mockFileSys,
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

function parseStdoutJson(outLines: string[]): Record<string, unknown> {
    return JSON.parse(outLines.join("").trim()) as Record<string, unknown>;
}

// --- Tests ---

describe("CurrentIssueScript", () => {
    describe("argument validation", () => {
        test("no args — exits 2, error envelope", async () => {
            const { deps, outLines } = makeMockDeps();
            const script = new CurrentIssueScript(deps);
            const code = await script.run(["bun", "current-issue.ts"]);
            expect(code).toBe(2);
            const out = parseStdoutJson(outLines);
            expect(out.status).toBe("error");
            expect(out.issue).toBeNull();
        });

        test("switch without issue ID — exits 2, error envelope", async () => {
            const { deps, outLines } = makeMockDeps();
            const script = new CurrentIssueScript(deps);
            const code = await script.run(["bun", "current-issue.ts", "switch"]);
            expect(code).toBe(2);
            const out = parseStdoutJson(outLines);
            expect(out.status).toBe("error");
            expect(out.issue).toBeNull();
        });

        test("unknown subcommand — exits 1, error envelope", async () => {
            const { deps, outLines } = makeMockDeps();
            const script = new CurrentIssueScript(deps);
            const code = await script.run(["bun", "current-issue.ts", "foobar"]);
            expect(code).toBe(1);
            const out = parseStdoutJson(outLines);
            expect(out.status).toBe("error");
            expect(out.issue).toBeNull();
            expect(String(out.error)).toContain("foobar");
        });
    });

    describe("switch — environment validation", () => {
        test("missing GITHUB_OWNER — exits 1, error envelope", async () => {
            const { deps, outLines } = makeMockDeps({ envVars: { GITHUB_REPO: "testrepo" } });
            const code = await new CurrentIssueScript(deps).run(["bun", "current-issue.ts", "switch", "28"]);
            expect(code).toBe(1);
            const out = parseStdoutJson(outLines);
            expect(out.status).toBe("error");
            expect(String(out.error)).toContain("GITHUB_OWNER");
        });

        test("missing GITHUB_REPO — exits 1, error envelope", async () => {
            const { deps, outLines } = makeMockDeps({ envVars: { GITHUB_OWNER: "testowner" } });
            const code = await new CurrentIssueScript(deps).run(["bun", "current-issue.ts", "switch", "28"]);
            expect(code).toBe(1);
            const out = parseStdoutJson(outLines);
            expect(out.status).toBe("error");
            expect(String(out.error)).toContain("GITHUB_REPO");
        });
    });

    describe("switch — dirty tree", () => {
        test("dirty tree — exits 1, error envelope, state file not written", async () => {
            const writeFileMock = mock(async (_path: string, _content: string) => {});
            const renameMock = mock(async (_from: string, _to: string) => {});

            const { deps, outLines } = makeMockDeps({
                shellRun: async (command: string[]) => {
                    if (command[0] === "git" && command[1] === "status") {
                        return makeShellResult({ stdout: " M some-file.ts\n" });
                    }
                    return makeShellResult();
                },
                fileWriterWriteFile: writeFileMock,
                fileSysRenameFile: renameMock,
            });

            const code = await new CurrentIssueScript(deps).run(["bun", "current-issue.ts", "switch", "28"]);
            expect(code).toBe(1);
            const out = parseStdoutJson(outLines);
            expect(out.status).toBe("error");
            expect(writeFileMock).not.toHaveBeenCalled();
            expect(renameMock).not.toHaveBeenCalled();
        });
    });

    describe("switch — gh issue fetch failure", () => {
        test("gh exits non-zero — exits 1, error envelope", async () => {
            const { deps, outLines } = makeMockDeps({
                shellRun: async (command: string[]) => {
                    if (command[0] === "git" && command[1] === "status") return makeShellResult({ stdout: "" });
                    if (command[0] === "gh") return makeShellResult({ stdout: "", stderr: "not found", exitCode: 1 });
                    return makeShellResult();
                },
            });

            const code = await new CurrentIssueScript(deps).run(["bun", "current-issue.ts", "switch", "28"]);
            expect(code).toBe(1);
            const out = parseStdoutJson(outLines);
            expect(out.status).toBe("error");
        });
    });

    describe("switch — invalid JSON / schema mismatch", () => {
        test("gh issue view returns invalid JSON — exits 1, error envelope with 'invalid JSON'", async () => {
            const { deps, outLines } = makeMockDeps({
                shellRun: async (command: string[]) => {
                    if (command[0] === "git" && command[1] === "status") return makeShellResult({ stdout: "" });
                    if (command[0] === "gh") {
                        return makeShellResult({ stdout: "<html>503 Service Unavailable</html>", exitCode: 0 });
                    }
                    return makeShellResult();
                },
            });

            const code = await new CurrentIssueScript(deps).run(["bun", "current-issue.ts", "switch", "28"]);
            expect(code).toBe(1);
            const out = parseStdoutJson(outLines);
            expect(out.status).toBe("error");
            expect(out.issue).toBeNull();
            expect(String(out.error)).toContain("invalid JSON");
        });

        test("gh issue view returns unexpected schema — exits 1, error envelope with 'unexpected gh issue response'", async () => {
            const { deps, outLines } = makeMockDeps({
                shellRun: async (command: string[]) => {
                    if (command[0] === "git" && command[1] === "status") return makeShellResult({ stdout: "" });
                    if (command[0] === "gh") {
                        return makeShellResult({ stdout: JSON.stringify({ unexpected: "shape" }), exitCode: 0 });
                    }
                    return makeShellResult();
                },
            });

            const code = await new CurrentIssueScript(deps).run(["bun", "current-issue.ts", "switch", "28"]);
            expect(code).toBe(1);
            const out = parseStdoutJson(outLines);
            expect(out.status).toBe("error");
            expect(out.issue).toBeNull();
            expect(String(out.error)).toContain("unexpected gh issue response");
        });

        test("resolve-issue-branch returns invalid JSON — exits 1, error envelope with 'invalid JSON'", async () => {
            const { deps, outLines } = makeMockDeps({
                shellRun: async (command: string[]) => {
                    if (command[0] === "git" && command[1] === "status") return makeShellResult({ stdout: "" });
                    if (command[0] === "gh") return makeShellResult({ stdout: makeGhIssueResponse() });
                    if (command[0] === "/usr/local/libexec/adda-dev-runtime/bin/resolve-issue-branch") {
                        return makeShellResult({ stdout: "<html>503 Service Unavailable</html>", exitCode: 0 });
                    }
                    return makeShellResult();
                },
            });

            const code = await new CurrentIssueScript(deps).run(["bun", "current-issue.ts", "switch", "28"]);
            expect(code).toBe(1);
            const out = parseStdoutJson(outLines);
            expect(out.status).toBe("error");
            expect(out.issue).toBeNull();
            expect(String(out.error)).toContain("invalid JSON");
        });

        test("resolve-issue-branch returns unexpected schema — exits 1, error envelope with 'unexpected resolve-issue-branch output'", async () => {
            const { deps, outLines } = makeMockDeps({
                shellRun: async (command: string[]) => {
                    if (command[0] === "git" && command[1] === "status") return makeShellResult({ stdout: "" });
                    if (command[0] === "gh") return makeShellResult({ stdout: makeGhIssueResponse() });
                    if (command[0] === "/usr/local/libexec/adda-dev-runtime/bin/resolve-issue-branch") {
                        return makeShellResult({ stdout: JSON.stringify({ unexpected: "shape" }), exitCode: 0 });
                    }
                    return makeShellResult();
                },
            });

            const code = await new CurrentIssueScript(deps).run(["bun", "current-issue.ts", "switch", "28"]);
            expect(code).toBe(1);
            const out = parseStdoutJson(outLines);
            expect(out.status).toBe("error");
            expect(out.issue).toBeNull();
            expect(String(out.error)).toContain("unexpected resolve-issue-branch output");
        });
    });

    describe("switch — resolve-issue-branch failures", () => {
        test("resolve-issue-branch returns ambiguous — exits 1, error envelope, subprocess stderr forwarded", async () => {
            const { deps, outLines, errLines } = makeMockDeps({
                shellRun: async (command: string[]) => {
                    if (command[0] === "git" && command[1] === "status") return makeShellResult({ stdout: "" });
                    if (command[0] === "gh") return makeShellResult({ stdout: makeGhIssueResponse() });
                    if (command[0] === "/usr/local/libexec/adda-dev-runtime/bin/resolve-issue-branch") {
                        return makeShellResult({
                            stdout: makeResolveResponse("ambiguous", "", "", "multiple linked branches: a, b"),
                            stderr: "ambiguity warning from resolve\n",
                            exitCode: 1,
                        });
                    }
                    return makeShellResult();
                },
            });

            const code = await new CurrentIssueScript(deps).run(["bun", "current-issue.ts", "switch", "28"]);
            expect(code).toBe(1);
            const out = parseStdoutJson(outLines);
            expect(out.status).toBe("error");
            expect(errLines.join("")).toContain("ambiguity warning from resolve");
        });

        test("resolve-issue-branch returns error status (exit 0) — exits 1, error envelope, subprocess stderr forwarded", async () => {
            const { deps, outLines, errLines } = makeMockDeps({
                shellRun: async (command: string[]) => {
                    if (command[0] === "git" && command[1] === "status") return makeShellResult({ stdout: "" });
                    if (command[0] === "gh") return makeShellResult({ stdout: makeGhIssueResponse() });
                    if (command[0] === "/usr/local/libexec/adda-dev-runtime/bin/resolve-issue-branch") {
                        return makeShellResult({
                            stdout: makeResolveResponse("error", "", "", "issue not found"),
                            stderr: "error details from resolve\n",
                            exitCode: 0,
                        });
                    }
                    return makeShellResult();
                },
            });

            const code = await new CurrentIssueScript(deps).run(["bun", "current-issue.ts", "switch", "28"]);
            expect(code).toBe(1);
            const out = parseStdoutJson(outLines);
            expect(out.status).toBe("error");
            expect(errLines.join("")).toContain("error details from resolve");
        });

        test("resolve-issue-branch exits non-zero — exits 1, error envelope, subprocess stderr forwarded", async () => {
            const { deps, outLines, errLines } = makeMockDeps({
                shellRun: async (command: string[]) => {
                    if (command[0] === "git" && command[1] === "status") return makeShellResult({ stdout: "" });
                    if (command[0] === "gh") return makeShellResult({ stdout: makeGhIssueResponse() });
                    if (command[0] === "/usr/local/libexec/adda-dev-runtime/bin/resolve-issue-branch") {
                        return makeShellResult({ stdout: "", stderr: "fatal resolve error\n", exitCode: 1 });
                    }
                    return makeShellResult();
                },
            });

            const code = await new CurrentIssueScript(deps).run(["bun", "current-issue.ts", "switch", "28"]);
            expect(code).toBe(1);
            const out = parseStdoutJson(outLines);
            expect(out.status).toBe("error");
            expect(errLines.join("")).toContain("fatal resolve error");
        });
    });

    describe("switch — git checkout failure", () => {
        test("git checkout fails — exits 1, error envelope, state file not written", async () => {
            const writeFileMock = mock(async (_path: string, _content: string) => {});
            const renameMock = mock(async (_from: string, _to: string) => {});

            const { deps, outLines } = makeMockDeps({
                shellRun: async (command: string[]) => {
                    if (command[0] === "git" && command[1] === "status") return makeShellResult({ stdout: "" });
                    if (command[0] === "gh") return makeShellResult({ stdout: makeGhIssueResponse() });
                    if (command[0] === "/usr/local/libexec/adda-dev-runtime/bin/resolve-issue-branch") {
                        return makeShellResult({ stdout: makeResolveResponse("feature_branch", "feature/28-test", "42") });
                    }
                    if (command[0] === "git" && command[1] === "checkout") {
                        return makeShellResult({ stdout: "", stderr: "branch not found", exitCode: 1 });
                    }
                    return makeShellResult();
                },
                fileWriterWriteFile: writeFileMock,
                fileSysRenameFile: renameMock,
            });

            const code = await new CurrentIssueScript(deps).run(["bun", "current-issue.ts", "switch", "28"]);
            expect(code).toBe(1);
            const out = parseStdoutJson(outLines);
            expect(out.status).toBe("error");
            expect(writeFileMock).not.toHaveBeenCalled();
            expect(renameMock).not.toHaveBeenCalled();
        });
    });

    describe("switch — success paths", () => {
        test("feature_branch resolution — exits 0, success envelope with branch and resolution", async () => {
            const { deps, outLines } = makeMockDeps({
                shellRun: async (command: string[]) => {
                    if (command[0] === "git" && command[1] === "status") return makeShellResult({ stdout: "" });
                    if (command[0] === "gh") {
                        return makeShellResult({
                            stdout: makeGhIssueResponse("My feature issue", ["feature", "phase: implement"], "OPEN"),
                        });
                    }
                    if (command[0] === "/usr/local/libexec/adda-dev-runtime/bin/resolve-issue-branch") {
                        return makeShellResult({
                            stdout: makeResolveResponse("feature_branch", "feature/28-my-feature", "42"),
                        });
                    }
                    if (command[0] === "git" && command[1] === "checkout") return makeShellResult();
                    return makeShellResult();
                },
            });

            const code = await new CurrentIssueScript(deps).run(["bun", "current-issue.ts", "switch", "28"]);
            expect(code).toBe(0);

            const out = parseStdoutJson(outLines);
            expect(out.status).toBe("success");
            expect(out.error).toBe("");

            const issue = out.issue as Record<string, string>;
            expect(issue.id).toBe("28");
            expect(issue.title).toBe("My feature issue");
            expect(issue.type).toBe("feature");
            expect(issue.phase).toBe("phase: implement");
            expect(issue.state).toBe("OPEN");
            expect(issue.pr).toBe("42");

            const details = out.details as Record<string, string>;
            expect(details.branch).toBe("feature/28-my-feature");
            expect(details.resolution).toBe("feature_branch");
        });

        test("main resolution — exits 0, success envelope with branch: main and resolution: main", async () => {
            const { deps, outLines } = makeMockDeps({
                shellRun: async (command: string[]) => {
                    if (command[0] === "git" && command[1] === "status") return makeShellResult({ stdout: "" });
                    if (command[0] === "gh") {
                        return makeShellResult({
                            stdout: makeGhIssueResponse("Main issue", ["chore"], "OPEN"),
                        });
                    }
                    if (command[0] === "/usr/local/libexec/adda-dev-runtime/bin/resolve-issue-branch") {
                        return makeShellResult({ stdout: makeResolveResponse("main", "", "") });
                    }
                    if (command[0] === "git" && command[1] === "checkout") return makeShellResult();
                    return makeShellResult();
                },
            });

            const code = await new CurrentIssueScript(deps).run(["bun", "current-issue.ts", "switch", "28"]);
            expect(code).toBe(0);

            const out = parseStdoutJson(outLines);
            expect(out.status).toBe("success");

            const details = out.details as Record<string, string>;
            expect(details.branch).toBe("main");
            expect(details.resolution).toBe("main");
        });

        test("issue with no type/phase labels — type and phase are empty strings", async () => {
            const { deps, outLines } = makeMockDeps({
                shellRun: async (command: string[]) => {
                    if (command[0] === "git" && command[1] === "status") return makeShellResult({ stdout: "" });
                    if (command[0] === "gh") {
                        return makeShellResult({
                            stdout: makeGhIssueResponse("No-label issue", [], "CLOSED"),
                        });
                    }
                    if (command[0] === "/usr/local/libexec/adda-dev-runtime/bin/resolve-issue-branch") {
                        return makeShellResult({ stdout: makeResolveResponse("feature_branch", "feature/28-no-label", "") });
                    }
                    if (command[0] === "git" && command[1] === "checkout") return makeShellResult();
                    return makeShellResult();
                },
            });

            const code = await new CurrentIssueScript(deps).run(["bun", "current-issue.ts", "switch", "28"]);
            expect(code).toBe(0);

            const out = parseStdoutJson(outLines);
            const issue = out.issue as Record<string, string>;
            expect(issue.type).toBe("");
            expect(issue.phase).toBe("");
            expect(issue.state).toBe("CLOSED");
            expect(issue.pr).toBe("");
        });
    });

    describe("show", () => {
        const validStateJson = JSON.stringify({
            id: "42",
            title: "A test issue",
            type: "feature",
            phase: "phase:implement",
            state: "OPEN",
            pr: "99",
        });

        test("no active issue (ENOENT) — exits 0, success envelope, all issue fields empty, details is {}", async () => {
            const { deps, outLines } = makeMockDeps();
            const code = await new CurrentIssueScript(deps).run(["bun", "current-issue.ts", "show"]);
            expect(code).toBe(0);
            const out = parseStdoutJson(outLines);
            expect(out.status).toBe("success");
            expect(out.error).toBe("");
            const issue = out.issue as Record<string, string>;
            expect(issue.id).toBe("");
            expect(issue.title).toBe("");
            expect(issue.type).toBe("");
            expect(issue.phase).toBe("");
            expect(issue.state).toBe("");
            expect(issue.pr).toBe("");
            expect(out.details).toEqual({});
        });

        test("active issue — exits 0, success envelope, issue fields match state", async () => {
            const { deps, outLines } = makeMockDeps({
                fileReaderReadFile: async (_path: string) => validStateJson,
            });
            const code = await new CurrentIssueScript(deps).run(["bun", "current-issue.ts", "show"]);
            expect(code).toBe(0);
            const out = parseStdoutJson(outLines);
            expect(out.status).toBe("success");
            expect(out.error).toBe("");
            const issue = out.issue as Record<string, string>;
            expect(issue.id).toBe("42");
            expect(issue.title).toBe("A test issue");
            expect(issue.type).toBe("feature");
            expect(issue.phase).toBe("phase:implement");
            expect(issue.state).toBe("OPEN");
            expect(issue.pr).toBe("99");
            expect(out.details).toEqual({});
        });

        test("corrupt state (invalid JSON) — exits 1, error envelope, error contains 'state file is corrupt'", async () => {
            const { deps, outLines } = makeMockDeps({
                fileReaderReadFile: async (_path: string) => "not json",
            });
            const code = await new CurrentIssueScript(deps).run(["bun", "current-issue.ts", "show"]);
            expect(code).toBe(1);
            const out = parseStdoutJson(outLines);
            expect(out.status).toBe("error");
            expect(String(out.error)).toContain("state file is corrupt");
        });

        test("corrupt state (schema mismatch) — exits 1, error envelope, error contains 'state file is corrupt'", async () => {
            const { deps, outLines } = makeMockDeps({
                fileReaderReadFile: async (_path: string) => JSON.stringify({ foo: "bar" }),
            });
            const code = await new CurrentIssueScript(deps).run(["bun", "current-issue.ts", "show"]);
            expect(code).toBe(1);
            const out = parseStdoutJson(outLines);
            expect(out.status).toBe("error");
            expect(String(out.error)).toContain("state file is corrupt");
        });
    });

    describe("IssueStateStore", () => {
        const validStateJson = JSON.stringify({
            id: "42",
            title: "A test issue",
            type: "feature",
            phase: "phase:implement",
            state: "OPEN",
            pr: "99",
        });

        describe("readState", () => {
            test("fileReader throws ENOENT — returns null (absent file)", async () => {
                const { deps } = makeMockDeps({
                    fileReaderReadFile: async (_path: string) => {
                        const enoent = Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
                        throw enoent;
                    },
                });
                const script: IssueStateStore = new CurrentIssueScript(deps);
                const result = await script.readState();
                expect(result).toBeNull();
            });

            test("fileReader throws non-ENOENT error — propagates the error", async () => {
                const { deps } = makeMockDeps({
                    fileReaderReadFile: async (_path: string) => {
                        throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
                    },
                });
                const script: IssueStateStore = new CurrentIssueScript(deps);
                await expect(script.readState()).rejects.toMatchObject({
                    message: expect.stringContaining("EACCES"),
                });
            });

            test("fileReader returns empty string — returns null", async () => {
                const { deps } = makeMockDeps({
                    fileReaderReadFile: async (_path: string) => "",
                });
                const script: IssueStateStore = new CurrentIssueScript(deps);
                const result = await script.readState();
                expect(result).toBeNull();
            });

            test("fileReader returns whitespace-only — returns null", async () => {
                const { deps } = makeMockDeps({
                    fileReaderReadFile: async (_path: string) => "   \n  ",
                });
                const script: IssueStateStore = new CurrentIssueScript(deps);
                const result = await script.readState();
                expect(result).toBeNull();
            });

            test("fileReader returns valid JSON matching IssueStateSchema — returns IssueState object", async () => {
                const { deps } = makeMockDeps({
                    fileReaderReadFile: async (_path: string) => validStateJson,
                });
                const script: IssueStateStore = new CurrentIssueScript(deps);
                const result = await script.readState();
                expect(result).not.toBeNull();
                expect(result?.id).toBe("42");
                expect(result?.title).toBe("A test issue");
                expect(result?.type).toBe("feature");
                expect(result?.phase).toBe("phase:implement");
                expect(result?.state).toBe("OPEN");
                expect(result?.pr).toBe("99");
            });

            test("fileReader returns invalid JSON — throws ScriptError with 'state file is corrupt' and emits error envelope", async () => {
                const { deps, outLines } = makeMockDeps({
                    fileReaderReadFile: async (_path: string) => "not valid json {{{",
                });
                const script: IssueStateStore = new CurrentIssueScript(deps);
                await expect(script.readState()).rejects.toMatchObject({
                    message: expect.stringContaining("state file is corrupt"),
                });
                const out = parseStdoutJson(outLines);
                expect(out.status).toBe("error");
                expect(String(out.error)).toContain("state file is corrupt");
            });

            test("fileReader returns valid JSON but wrong schema — throws ScriptError with 'state file is corrupt' and emits error envelope", async () => {
                const { deps, outLines } = makeMockDeps({
                    fileReaderReadFile: async (_path: string) => JSON.stringify({ foo: "bar" }),
                });
                const script: IssueStateStore = new CurrentIssueScript(deps);
                await expect(script.readState()).rejects.toMatchObject({
                    message: expect.stringContaining("state file is corrupt"),
                });
                const out = parseStdoutJson(outLines);
                expect(out.status).toBe("error");
                expect(String(out.error)).toContain("state file is corrupt");
            });
        });

        describe("deleteState", () => {
            test("calls fileSys.deleteFile with STATE_PATH exactly once", async () => {
                const deleteFileMock = mock(async (_path: string) => {});
                const { deps } = makeMockDeps({ fileSysDeleteFile: deleteFileMock });
                const script: IssueStateStore = new CurrentIssueScript(deps);
                await script.deleteState();
                expect(deleteFileMock).toHaveBeenCalledTimes(1);
                expect(deleteFileMock).toHaveBeenCalledWith("/run/.adda-current-issue");
            });

            test("propagates error thrown by fileSys.deleteFile", async () => {
                const deleteError = new Error("ENOENT: file not found");
                const { deps } = makeMockDeps({
                    fileSysDeleteFile: async (_path: string) => {
                        throw deleteError;
                    },
                });
                const script: IssueStateStore = new CurrentIssueScript(deps);
                await expect(script.deleteState()).rejects.toThrow("ENOENT: file not found");
            });
        });
    });
});
