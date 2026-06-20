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
import { ScriptShellError } from "../lib/index";
import { CurrentIssueScript, SilentStore, type IssueStateStore } from "./current-issue";

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

function makeResolveResponse(resolution: "feature_branch" | "main", branch = "", pr = "", issue_id = "28"): string {
    return JSON.stringify({ status: "ok", result: { issue_id, resolution, branch, pr }, error: null });
}

function makeResolveFailResponse(reason: string, message: string, details: Record<string, unknown> = {}): string {
    return JSON.stringify({ status: "fail", result: null, error: { reason, message, details } });
}

/** Helper: build a raw issue response for gh api /repos/{owner}/{repo}/issues/{n} */
function makeRawIssueResponse(
    number: number,
    title: string,
    state: "open" | "closed",
    id: number,
    labels: string[],
    parent_issue_url: string | null,
    repository_url = "https://api.github.com/repos/testowner/testrepo",
): string {
    return JSON.stringify({
        number,
        title,
        state,
        id,
        labels: labels.map((name) => ({ name })),
        parent_issue_url,
        repository_url,
    });
}

/** Helper: build a raw sub-issue line for gh api /repos/.../sub_issues NDJSON */
function makeRawSubIssue(
    number: number,
    title: string,
    state: "open" | "closed",
    labels: string[],
    repository_url = "https://api.github.com/repos/testowner/testrepo",
): string {
    return JSON.stringify({
        number,
        title,
        state,
        labels: labels.map((name) => ({ name })),
        repository_url,
    });
}

/**
 * Fallback handler for gh api commands from hierarchy functions.
 * Returns a minimal valid issue with no parent, or empty for sub_issues.
 */
function defaultHierarchyApiResponse(url: string): string {
    const issueMatch = url.match(/\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)/);
    if (!issueMatch) return "";
    const owner = issueMatch[1]!;
    const repo = issueMatch[2]!;
    const issueNumber = Number(issueMatch[3]!);
    if (url.endsWith("/sub_issues")) {
        return "";
    }
    return makeRawIssueResponse(
        issueNumber,
        `Issue #${issueNumber}`,
        "open",
        issueNumber * 1000 + 1,
        [],
        null,
        `https://api.github.com/repos/${owner}/${repo}`,
    );
}

// --- Mock factory ---

interface MockDepsOptions {
    shellRun?: (command: string[]) => Promise<ShellResult>;
    envVars?: Record<string, string>;
    fileReaderReadFile?: (path: string) => Promise<string>;
    fileWriterWriteFile?: (pathPattern: string, content: string) => Promise<string>;
    fileSysDeleteFile?: (path: string) => Promise<void>;
    fileSysFileExists?: (path: string) => Promise<boolean>;
    /** Optional custom handler for gh api calls from hierarchy functions.
     * Receives the full command array; should return a ShellResult or null/undefined to fall through
     * to the default hierarchy response (no parent, no children). */
    hierarchyApi?: (command: string[]) => ShellResult | null | undefined;
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
    // Hierarchy API calls default to no parent and no children.
    const defaultShellRun = async (command: string[]): Promise<ShellResult> => {
        const cmd = command[0];
        if (cmd === "git" && command[1] === "status") {
            return makeShellResult({ stdout: "" });
        }
        if (cmd === "gh" && command[1] === "issue") {
            return makeShellResult({ stdout: makeGhIssueResponse() });
        }
        if (cmd === "gh" && command[1] === "api") {
            const url = command[command.length - 1] as string;
            return makeShellResult({ stdout: defaultHierarchyApiResponse(url) });
        }
        if (cmd === "/usr/local/libexec/adda-dev-runtime/bin/resolve-issue-branch") {
            return makeShellResult({ stdout: makeResolveResponse("feature_branch", "feature/28-test-issue", "42") });
        }
        if (cmd === "git" && command[1] === "checkout") {
            return makeShellResult();
        }
        return makeShellResult();
    };

    // gh api calls from hierarchy functions are always handled. Tests that need custom
    // hierarchy responses can provide a hierarchyApi handler in options.
    const wrappedRun = options.shellRun
        ? async (command: string[]): Promise<ShellResult> => {
              if (command[0] === "gh" && command[1] === "api") {
                  const url = command[command.length - 1] as string;
                  // Allow custom hierarchy handler
                  if (options.hierarchyApi) {
                      const result = options.hierarchyApi(command);
                      if (result) return result;
                  }
                  return makeShellResult({ stdout: defaultHierarchyApiResponse(url) });
              }
              return options.shellRun!(command);
          }
        : defaultShellRun;

    const mockShell: Shell = {
        run: mock(wrappedRun),
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
        writeFile: mock(
            options.fileWriterWriteFile ?? (async (_pathPattern: string, _content: string) => "/tmp/mock-state.json"),
        ),
    };

    const mockFileSys: FileSys = {
        deleteFile: mock(options.fileSysDeleteFile ?? (async (_path: string) => {})),
        fileExists: mock(options.fileSysFileExists ?? (async (_path: string) => false)),
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
        test("no args — exits 2, fail envelope", async () => {
            const { deps, outLines } = makeMockDeps();
            const script = new CurrentIssueScript(deps);
            const code = await script.run(["bun", "current-issue.ts"]);
            expect(code).toBe(2);
            const out = parseStdoutJson(outLines);
            expect(out.status).toBe("fail");
            expect(out.result).toBeNull();
        });

        test("switch without issue ID — exits 2, fail envelope", async () => {
            const { deps, outLines } = makeMockDeps();
            const script = new CurrentIssueScript(deps);
            const code = await script.run(["bun", "current-issue.ts", "switch"]);
            expect(code).toBe(2);
            const out = parseStdoutJson(outLines);
            expect(out.status).toBe("fail");
            expect(out.result).toBeNull();
        });

        test("unknown subcommand — exits 2, fail envelope", async () => {
            const { deps, outLines } = makeMockDeps();
            const script = new CurrentIssueScript(deps);
            const code = await script.run(["bun", "current-issue.ts", "foobar"]);
            expect(code).toBe(2);
            const out = parseStdoutJson(outLines);
            expect(out.status).toBe("fail");
            expect(out.result).toBeNull();
            const error = out.error as Record<string, unknown>;
            expect(String(error.message)).toContain("foobar");
        });

        test("show --skip-repo-init — exits 2, fail envelope, error contains '--skip-repo-init is not valid for'", async () => {
            const { deps, outLines } = makeMockDeps();
            const code = await new CurrentIssueScript(deps).run(["bun", "current-issue.ts", "show", "--skip-repo-init"]);
            expect(code).toBe(2);
            const out = parseStdoutJson(outLines);
            expect(out.status).toBe("fail");
            expect(out.result).toBeNull();
            const error = out.error as Record<string, unknown>;
            expect(String(error.message)).toContain("--skip-repo-init is not valid for 'show'");
        });

        test("get id --skip-repo-init — exits 2, fail envelope, error contains '--skip-repo-init is not valid for'", async () => {
            const { deps, outLines } = makeMockDeps();
            const code = await new CurrentIssueScript(deps).run(["bun", "current-issue.ts", "get", "id", "--skip-repo-init"]);
            expect(code).toBe(2);
            const out = parseStdoutJson(outLines);
            expect(out.status).toBe("fail");
            expect(out.result).toBeNull();
            const error = out.error as Record<string, unknown>;
            expect(String(error.message)).toContain("--skip-repo-init is not valid for 'get'");
        });

        test("show --with-hierarchy — exits 0, ok envelope", async () => {
            const { deps, outLines } = makeMockDeps({
                fileReaderReadFile: async (_path: string) => {
                    const enoent = Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
                    throw enoent;
                },
            });
            const code = await new CurrentIssueScript(deps).run(["bun", "current-issue.ts", "show", "--with-hierarchy"]);
            expect(code).toBe(0);
            const out = parseStdoutJson(outLines);
            expect(out.status).toBe("ok");
        });
    });

    describe("switch — environment validation", () => {
        test("missing GITHUB_OWNER — exits 1, fail envelope", async () => {
            const { deps, outLines } = makeMockDeps({ envVars: { GITHUB_REPO: "testrepo" } });
            const code = await new CurrentIssueScript(deps).run(["bun", "current-issue.ts", "switch", "28"]);
            expect(code).toBe(1);
            const out = parseStdoutJson(outLines);
            expect(out.status).toBe("fail");
            const error = out.error as Record<string, unknown>;
            expect(String(error.message)).toContain("GITHUB_OWNER");
        });

        test("missing GITHUB_REPO — exits 1, fail envelope", async () => {
            const { deps, outLines } = makeMockDeps({ envVars: { GITHUB_OWNER: "testowner" } });
            const code = await new CurrentIssueScript(deps).run(["bun", "current-issue.ts", "switch", "28"]);
            expect(code).toBe(1);
            const out = parseStdoutJson(outLines);
            expect(out.status).toBe("fail");
            const error = out.error as Record<string, unknown>;
            expect(String(error.message)).toContain("GITHUB_REPO");
        });
    });

    describe("switch — dirty tree", () => {
        test("dirty tree — exits 1, fail envelope, state file not written", async () => {
            const { deps, outLines } = makeMockDeps({
                shellRun: async (command: string[]) => {
                    if (command[0] === "git" && command[1] === "status") {
                        return makeShellResult({ stdout: " M some-file.ts\n" });
                    }
                    return makeShellResult();
                },
            });

            const code = await new CurrentIssueScript(deps).run(["bun", "current-issue.ts", "switch", "28"]);
            expect(code).toBe(1);
            const out = parseStdoutJson(outLines);
            expect(out.status).toBe("fail");
            expect(deps.fileWriter.writeFile).not.toHaveBeenCalled();
        });
    });

    describe("switch — gh issue fetch failure", () => {
        test("gh exits non-zero — exits 1, fail envelope", async () => {
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
            expect(out.status).toBe("fail");
        });
    });

    describe("switch — invalid JSON / schema mismatch", () => {
        test("gh issue view returns invalid JSON — exits 1, fail envelope with 'invalid JSON'", async () => {
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
            expect(out.status).toBe("fail");
            expect(out.result).toBeNull();
            const error = out.error as Record<string, unknown>;
            expect(String(error.message)).toContain("invalid JSON");
        });

        test("gh issue view returns unexpected schema — exits 1, fail envelope with 'unexpected gh issue response'", async () => {
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
            expect(out.status).toBe("fail");
            expect(out.result).toBeNull();
            const error = out.error as Record<string, unknown>;
            expect(String(error.message)).toContain("unexpected gh issue response");
        });

        test("resolve-issue-branch returns invalid JSON — exits 1, fail envelope with 'invalid JSON'", async () => {
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
            expect(out.status).toBe("fail");
            expect(out.result).toBeNull();
            const error = out.error as Record<string, unknown>;
            expect(String(error.message)).toContain("invalid JSON");
        });

        test("resolve-issue-branch returns unexpected schema — exits 1, fail envelope with 'unexpected resolve-issue-branch output'", async () => {
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
            expect(out.status).toBe("fail");
            expect(out.result).toBeNull();
            const error = out.error as Record<string, unknown>;
            expect(String(error.message)).toContain("unexpected resolve-issue-branch output");
        });
    });

    describe("switch — resolve-issue-branch failures", () => {
        test("resolve-issue-branch exits non-zero — exits 1, shell_error envelope, subprocess stderr forwarded", async () => {
            const { deps, outLines, errLines } = makeMockDeps({
                shellRun: async (command: string[]) => {
                    if (command[0] === "git" && command[1] === "status") return makeShellResult({ stdout: "" });
                    if (command[0] === "gh") return makeShellResult({ stdout: makeGhIssueResponse() });
                    if (command[0] === "/usr/local/libexec/adda-dev-runtime/bin/resolve-issue-branch") {
                        throw new ScriptShellError(command.join(" "), 1, "", "ambiguity warning from resolve\n");
                    }
                    return makeShellResult();
                },
            });

            const code = await new CurrentIssueScript(deps).run(["bun", "current-issue.ts", "switch", "28"]);
            expect(code).toBe(1);
            const out = parseStdoutJson(outLines);
            expect(out.status).toBe("fail");
            expect(out.error as Record<string, unknown>).toMatchObject({ reason: "shell_error" });
            expect(errLines.join("")).toContain("ambiguity warning from resolve");
        });

        test("resolve-issue-branch returns fail status (exit 0) — exits 1, fail envelope, subprocess stderr forwarded", async () => {
            const { deps, outLines, errLines } = makeMockDeps({
                shellRun: async (command: string[]) => {
                    if (command[0] === "git" && command[1] === "status") return makeShellResult({ stdout: "" });
                    if (command[0] === "gh") return makeShellResult({ stdout: makeGhIssueResponse() });
                    if (command[0] === "/usr/local/libexec/adda-dev-runtime/bin/resolve-issue-branch") {
                        return makeShellResult({
                            stdout: makeResolveFailResponse("issue_not_found", "issue #28 not found"),
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
            expect(out.status).toBe("fail");
            expect(errLines.join("")).toContain("error details from resolve");
        });

        test("resolve-issue-branch exits non-zero — exits 1, fail envelope, subprocess stderr forwarded", async () => {
            const { deps, outLines, errLines } = makeMockDeps({
                shellRun: async (command: string[]) => {
                    if (command[0] === "git" && command[1] === "status") return makeShellResult({ stdout: "" });
                    if (command[0] === "gh") return makeShellResult({ stdout: makeGhIssueResponse() });
                    if (command[0] === "/usr/local/libexec/adda-dev-runtime/bin/resolve-issue-branch") {
                        throw new ScriptShellError(command[0], 1, "", "fatal resolve error\n");
                    }
                    return makeShellResult();
                },
            });

            const code = await new CurrentIssueScript(deps).run(["bun", "current-issue.ts", "switch", "28"]);
            expect(code).toBe(1);
            const out = parseStdoutJson(outLines);
            expect(out.status).toBe("fail");
            expect(errLines.join("")).toContain("fatal resolve error");
        });
    });

    describe("switch — git checkout failure", () => {
        test("git checkout fails — exits 1, fail envelope, state file not written", async () => {
            const { deps, outLines } = makeMockDeps({
                shellRun: async (command: string[]) => {
                    if (command[0] === "git" && command[1] === "status") return makeShellResult({ stdout: "" });
                    if (command[0] === "gh") return makeShellResult({ stdout: makeGhIssueResponse() });
                    if (command[0] === "/usr/local/libexec/adda-dev-runtime/bin/resolve-issue-branch") {
                        return makeShellResult({ stdout: makeResolveResponse("feature_branch", "feature/28-test", "42") });
                    }
                    if (command[0] === "git" && command[1] === "checkout") {
                        throw new ScriptShellError(command.join(" "), 1, "", "branch not found");
                    }
                    return makeShellResult();
                },
            });

            const code = await new CurrentIssueScript(deps).run(["bun", "current-issue.ts", "switch", "28"]);
            expect(code).toBe(1);
            const out = parseStdoutJson(outLines);
            expect(out.status).toBe("fail");
            expect(deps.fileWriter.writeFile).not.toHaveBeenCalled();
        });
    });

    describe("switch — git pull failure", () => {
        test("git pull fails — exits 1, fail envelope, state file not written", async () => {
            const { deps, outLines } = makeMockDeps({
                shellRun: async (command: string[]) => {
                    if (command[0] === "git" && command[1] === "status") return makeShellResult({ stdout: "" });
                    if (command[0] === "gh") return makeShellResult({ stdout: makeGhIssueResponse() });
                    if (command[0] === "/usr/local/libexec/adda-dev-runtime/bin/resolve-issue-branch") {
                        return makeShellResult({ stdout: makeResolveResponse("feature_branch", "feature/28-test", "42") });
                    }
                    if (command[0] === "git" && command[1] === "checkout") return makeShellResult();
                    if (command[0] === "git" && command[1] === "pull") {
                        throw new ScriptShellError("git pull", 1, "", "fatal: couldn't find remote ref HEAD");
                    }
                    return makeShellResult();
                },
            });

            const code = await new CurrentIssueScript(deps).run(["bun", "current-issue.ts", "switch", "28"]);
            expect(code).toBe(1);
            const out = parseStdoutJson(outLines);
            expect(out.status).toBe("fail");
            expect(deps.fileWriter.writeFile).not.toHaveBeenCalled();
        });
    });

    describe("switch — success paths", () => {
        test("feature_branch resolution — exits 0, ok envelope with branch and resolution", async () => {
            const { deps, outLines } = makeMockDeps({
                shellRun: async (command: string[]) => {
                    if (command[0] === "git" && command[1] === "status") return makeShellResult({ stdout: "" });
                    if (command[0] === "gh" && command[1] === "issue") {
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
                    if (command[0] === "gh" && command[1] === "api") {
                        const url = command[command.length - 1] as string;
                        return makeShellResult({ stdout: defaultHierarchyApiResponse(url) });
                    }
                    return makeShellResult();
                },
            });

            const code = await new CurrentIssueScript(deps).run(["bun", "current-issue.ts", "switch", "28"]);
            expect(code).toBe(0);

            const out = parseStdoutJson(outLines);
            expect(out.status).toBe("ok");
            expect(out.error).toBeNull();

            const result = out.result as Record<string, unknown>;
            const issue = result.issue as Record<string, string>;
            expect(issue.id).toBe("28");
            expect(issue.title).toBe("My feature issue");
            expect(issue.type).toBe("feature");
            expect(issue.phase).toBe("phase: implement");
            expect(issue.state).toBe("open");
            expect(issue.pr).toBe("42");
            expect(issue.owner).toBe("testowner");
            expect(issue.repo).toBe("testrepo");

            const details = result.details as Record<string, string>;
            expect(details.branch).toBe("feature/28-my-feature");
            expect(details.resolution).toBe("feature_branch");
        });

        test("main resolution — exits 0, ok envelope with branch: main and resolution: main", async () => {
            const { deps, outLines } = makeMockDeps({
                shellRun: async (command: string[]) => {
                    if (command[0] === "git" && command[1] === "status") return makeShellResult({ stdout: "" });
                    if (command[0] === "gh" && command[1] === "issue") {
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
            expect(out.status).toBe("ok");

            const result = out.result as Record<string, unknown>;
            const details = result.details as Record<string, string>;
            expect(details.branch).toBe("main");
            expect(details.resolution).toBe("main");
        });

        test("issue with no type/phase labels — type and phase are empty strings", async () => {
            const { deps, outLines } = makeMockDeps({
                shellRun: async (command: string[]) => {
                    if (command[0] === "git" && command[1] === "status") return makeShellResult({ stdout: "" });
                    if (command[0] === "gh" && command[1] === "issue") {
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
            const result = out.result as Record<string, unknown>;
            const issue = result.issue as Record<string, string>;
            expect(issue.type).toBe("");
            expect(issue.phase).toBe("");
            expect(issue.state).toBe("closed");
            expect(issue.pr).toBe("");
        });
    });

    describe("switch — hierarchy enrichment", () => {
        test("hierarchy populated with parent, children, siblings — persisted in state", async () => {
            // Scenario: issue #28, parent #10, children of #28 = [#30], siblings (parent's children) = [#30, #31], exclude self
            const { deps, outLines } = makeMockDeps({
                shellRun: async (command: string[]) => {
                    if (command[0] === "git" && command[1] === "status") return makeShellResult({ stdout: "" });
                    if (command[0] === "gh" && command[1] === "issue") {
                        return makeShellResult({
                            stdout: makeGhIssueResponse("Hierarchy issue", ["feature", "phase: implement"], "OPEN"),
                        });
                    }
                    if (command[0] === "/usr/local/libexec/adda-dev-runtime/bin/resolve-issue-branch") {
                        return makeShellResult({
                            stdout: makeResolveResponse("feature_branch", "feature/28-test", "42"),
                        });
                    }
                    if (command[0] === "git" && command[1] === "checkout") return makeShellResult();
                    if (command[0] === "git" && command[1] === "pull") return makeShellResult();
                    return makeShellResult();
                },
                hierarchyApi: (command: string[]) => {
                    const url = command[command.length - 1] as string;
                    if (url.includes("/issues/28") && url.endsWith("/sub_issues")) {
                        return makeShellResult({ stdout: makeRawSubIssue(30, "Child", "open", ["feature"]) });
                    }
                    if (url.includes("/issues/28") && !url.includes("sub_issues")) {
                        return makeShellResult({
                            stdout: makeRawIssueResponse(
                                28,
                                "Hierarchy issue",
                                "open",
                                28001,
                                ["feature"],
                                "https://api.github.com/repos/o/r/issues/10",
                            ),
                        });
                    }
                    if (url.includes("/issues/10") && url.endsWith("/sub_issues")) {
                        return makeShellResult({
                            stdout: [
                                makeRawSubIssue(30, "Child", "open", ["feature"]),
                                makeRawSubIssue(31, "Sibling", "closed", ["chore"]),
                            ].join("\n"),
                        });
                    }
                    if (url.includes("/issues/10")) {
                        return makeShellResult({
                            stdout: makeRawIssueResponse(
                                10,
                                "Parent",
                                "open",
                                10001,
                                ["feature"],
                                null,
                                "https://api.github.com/repos/o/r",
                            ),
                        });
                    }
                    return null; // fall through to default
                },
            });

            const code = await new CurrentIssueScript(deps).run(["bun", "current-issue.ts", "switch", "28"]);
            expect(code).toBe(0);

            const out = parseStdoutJson(outLines);
            expect(out.status).toBe("ok");
            const result = out.result as Record<string, unknown>;
            const issue = result.issue as Record<string, unknown>;

            expect(issue.id).toBe("28");

            // parent is a GitHubIssueHeader
            const parent = issue.parent as Record<string, unknown>;
            expect(parent).not.toBeNull();
            expect(parent.number).toBe(10);
            expect(parent.title).toBe("Parent");
            expect(parent.state).toBe("open");

            // children array
            const children = issue.children as Array<Record<string, unknown>>;
            expect(children).toHaveLength(1);
            expect(children[0].number).toBe(30);
            expect(children[0].title).toBe("Child");

            // siblings array (parent's children minus self)
            const siblings = issue.siblings as Array<Record<string, unknown>>;
            // Parent #10 has children #30, #31 — self (#28) filtered out
            expect(siblings).toHaveLength(2);
        });

        test("orphan (no parent) — parent null, siblings empty", async () => {
            const { deps, outLines } = makeMockDeps({
                shellRun: async (command: string[]) => {
                    if (command[0] === "git" && command[1] === "status") return makeShellResult({ stdout: "" });
                    if (command[0] === "gh" && command[1] === "issue") {
                        return makeShellResult({
                            stdout: makeGhIssueResponse("Orphan issue", ["feature"], "OPEN"),
                        });
                    }
                    if (command[0] === "/usr/local/libexec/adda-dev-runtime/bin/resolve-issue-branch") {
                        return makeShellResult({
                            stdout: makeResolveResponse("feature_branch", "feature/28-orphan", "42"),
                        });
                    }
                    if (command[0] === "git" && command[1] === "checkout") return makeShellResult();
                    if (command[0] === "git" && command[1] === "pull") return makeShellResult();
                    return makeShellResult();
                },
                // Default hierarchy response already returns no parent, no children
            });

            const code = await new CurrentIssueScript(deps).run(["bun", "current-issue.ts", "switch", "28"]);
            expect(code).toBe(0);

            const out = parseStdoutJson(outLines);
            expect(out.status).toBe("ok");
            const result = out.result as Record<string, unknown>;
            const issue = result.issue as Record<string, unknown>;
            expect(issue.parent).toBeNull();
            expect(issue.children).toEqual([]);
            expect(issue.siblings).toEqual([]);
        });

        test("children hierarchy API fails — exits 1, fail envelope", async () => {
            // Children always hard-fail. Simulate a ScriptShellError for children sub_issues call.
            const { deps, outLines } = makeMockDeps({
                shellRun: async (command: string[]) => {
                    if (command[0] === "git" && command[1] === "status") return makeShellResult({ stdout: "" });
                    if (command[0] === "gh" && command[1] === "issue") {
                        return makeShellResult({
                            stdout: makeGhIssueResponse("Failing hierarchy", ["feature"], "OPEN"),
                        });
                    }
                    if (command[0] === "/usr/local/libexec/adda-dev-runtime/bin/resolve-issue-branch") {
                        return makeShellResult({
                            stdout: makeResolveResponse("feature_branch", "feature/28-fail", "42"),
                        });
                    }
                    if (command[0] === "git" && command[1] === "checkout") return makeShellResult();
                    if (command[0] === "git" && command[1] === "pull") return makeShellResult();
                    return makeShellResult();
                },
                hierarchyApi: (command: string[]) => {
                    const url = command[command.length - 1] as string;
                    // Let the parent issue fetch return valid data (no parent)
                    if (!url.endsWith("/sub_issues")) {
                        return makeShellResult({ stdout: defaultHierarchyApiResponse(url) });
                    }
                    // Children sub_issues call throws to simulate hard failure
                    throw new ScriptShellError(command.join(" "), 1, "", "HTTP 500");
                },
            });

            const code = await new CurrentIssueScript(deps).run(["bun", "current-issue.ts", "switch", "28"]);
            expect(code).toBe(1);

            const out = parseStdoutJson(outLines);
            expect(out.status).toBe("fail");
            expect(out.result).toBeNull();
        });

        test("parent fetch fails with foreign_repo_inaccessible — switch succeeds with null parent and hierarchyWarning, fetchSiblings not called", async () => {
            // Simulate fetchIssueById succeeding (has cross-repo parent url) but foreign repo fetch throwing
            const foreignSubIssuesCalls: string[] = [];
            const { deps, outLines } = makeMockDeps({
                shellRun: async (command: string[]) => {
                    if (command[0] === "git" && command[1] === "status") return makeShellResult({ stdout: "" });
                    if (command[0] === "gh" && command[1] === "issue") {
                        return makeShellResult({
                            stdout: makeGhIssueResponse("Cross-repo child", ["feature"], "OPEN"),
                        });
                    }
                    if (command[0] === "/usr/local/libexec/adda-dev-runtime/bin/resolve-issue-branch") {
                        return makeShellResult({
                            stdout: makeResolveResponse("feature_branch", "feature/28-cross-repo", "42"),
                        });
                    }
                    if (command[0] === "git" && command[1] === "checkout") return makeShellResult();
                    if (command[0] === "git" && command[1] === "pull") return makeShellResult();
                    return makeShellResult();
                },
                hierarchyApi: (command: string[]) => {
                    const url = command[command.length - 1] as string;
                    // Track sub_issues calls to the foreign repo parent
                    if (url.includes("/repos/foreign/repo/") && url.endsWith("/sub_issues")) {
                        foreignSubIssuesCalls.push(url);
                    }
                    // fetchIssueById for #28: returns issue with cross-repo parent URL
                    if (url.includes("/issues/28") && !url.endsWith("/sub_issues")) {
                        return makeShellResult({
                            stdout: makeRawIssueResponse(
                                28,
                                "Cross-repo child",
                                "open",
                                28001,
                                ["feature"],
                                "https://api.github.com/repos/foreign/repo/issues/5",
                            ),
                        });
                    }
                    // Foreign repo fetch throws (inaccessible)
                    if (url.includes("/repos/foreign/repo/")) {
                        throw new ScriptShellError(command.join(" "), 1, "", "HTTP 404: Not Found");
                    }
                    // Children and sub_issues for the current issue succeed normally
                    return makeShellResult({ stdout: defaultHierarchyApiResponse(url) });
                },
            });

            const code = await new CurrentIssueScript(deps).run(["bun", "current-issue.ts", "switch", "28"]);
            expect(code).toBe(0);

            const out = parseStdoutJson(outLines);
            expect(out.status).toBe("ok");
            const result = out.result as Record<string, unknown>;
            const issue = result.issue as Record<string, unknown>;
            expect(issue.parent).toBeNull();
            expect(issue.siblings).toEqual([]);
            const details = result.details as Record<string, unknown>;
            expect(typeof details.hierarchyWarning).toBe("string");
            expect((details.hierarchyWarning as string).length).toBeGreaterThan(0);
            // fetchSiblings must not be called — no sub_issues request to the foreign repo parent
            expect(foreignSubIssuesCalls).toHaveLength(0);
        });

        test("parent fetch fails with non-foreign_repo_inaccessible error — switch propagates the error", async () => {
            // When the foreign repo fetch fails with a non-HTTP-4xx error (e.g. connection refused),
            // fetchParent re-throws the original ScriptShellError, and switch must not degrade gracefully.
            const { deps, outLines } = makeMockDeps({
                shellRun: async (command: string[]) => {
                    if (command[0] === "git" && command[1] === "status") return makeShellResult({ stdout: "" });
                    if (command[0] === "gh" && command[1] === "issue") {
                        return makeShellResult({
                            stdout: makeGhIssueResponse("Cross-repo child", ["feature"], "OPEN"),
                        });
                    }
                    if (command[0] === "/usr/local/libexec/adda-dev-runtime/bin/resolve-issue-branch") {
                        return makeShellResult({
                            stdout: makeResolveResponse("feature_branch", "feature/28-cross-repo", "42"),
                        });
                    }
                    if (command[0] === "git" && command[1] === "checkout") return makeShellResult();
                    if (command[0] === "git" && command[1] === "pull") return makeShellResult();
                    return makeShellResult();
                },
                hierarchyApi: (command: string[]) => {
                    const url = command[command.length - 1] as string;
                    // fetchIssueById for #28: returns issue with cross-repo parent URL
                    if (url.includes("/issues/28") && !url.endsWith("/sub_issues")) {
                        return makeShellResult({
                            stdout: makeRawIssueResponse(
                                28,
                                "Cross-repo child",
                                "open",
                                28001,
                                ["feature"],
                                "https://api.github.com/repos/foreign/repo/issues/5",
                            ),
                        });
                    }
                    // Foreign repo fetch fails with connection refused (no HTTP 4xx)
                    if (url.includes("/repos/foreign/repo/") && !url.endsWith("/sub_issues")) {
                        throw new ScriptShellError(command.join(" "), 1, "", "connection refused");
                    }
                    return makeShellResult({ stdout: defaultHierarchyApiResponse(url) });
                },
            });

            const code = await new CurrentIssueScript(deps).run(["bun", "current-issue.ts", "switch", "28"]);
            // Must fail — non-inaccessible errors propagate
            expect(code).toBe(1);

            const out = parseStdoutJson(outLines);
            expect(out.status).toBe("fail");
            expect(out.result).toBeNull();
            const error = out.error as Record<string, unknown>;
            // The propagated error is a ScriptShellError (reason: "shell_error")
            expect(error.reason).toBe("shell_error");
            // hierarchyWarning must NOT appear in details
            const detailsFields = Object.keys(out);
            expect(detailsFields).not.toContain("hierarchyWarning");
        });
    });

    describe("switch — hook statuses", () => {
        test("--skip-repo-init — exits 0, details.hook.status is 'skipped', hook not invoked", async () => {
            const hookRunMock = mock(async (_command: string[]) => makeShellResult());
            const { deps, outLines } = makeMockDeps({
                shellRun: async (command: string[]) => {
                    if (command[0] === "git" && command[1] === "status") return makeShellResult({ stdout: "" });
                    if (command[0] === "gh" && command[1] === "issue")
                        return makeShellResult({ stdout: makeGhIssueResponse() });
                    if (command[0] === "/usr/local/libexec/adda-dev-runtime/bin/resolve-issue-branch") {
                        return makeShellResult({ stdout: makeResolveResponse("feature_branch", "feature/28-test", "42") });
                    }
                    if (command[0] === "git" && command[1] === "checkout") return makeShellResult();
                    if (command[0] === "bash") return hookRunMock(command);
                    return makeShellResult();
                },
                fileSysFileExists: async (_path: string) => true,
            });

            const code = await new CurrentIssueScript(deps).run([
                "bun",
                "current-issue.ts",
                "switch",
                "28",
                "--skip-repo-init",
            ]);
            expect(code).toBe(0);

            const out = parseStdoutJson(outLines);
            expect(out.status).toBe("ok");
            const result = out.result as Record<string, unknown>;
            const details = result.details as Record<string, unknown>;
            const hook = details.hook as Record<string, string>;
            expect(hook.status).toBe("skipped");
            expect(hookRunMock).not.toHaveBeenCalled();
        });

        test("hook absent — exits 0, details.hook.status is 'absent'", async () => {
            const { deps, outLines } = makeMockDeps({
                fileSysFileExists: async (_path: string) => false,
            });

            const code = await new CurrentIssueScript(deps).run(["bun", "current-issue.ts", "switch", "28"]);
            expect(code).toBe(0);

            const out = parseStdoutJson(outLines);
            expect(out.status).toBe("ok");
            const result = out.result as Record<string, unknown>;
            const details = result.details as Record<string, unknown>;
            const hook = details.hook as Record<string, string>;
            expect(hook.status).toBe("absent");
        });

        test("hook present and succeeds — exits 0, details.hook.status is 'ok', output captured", async () => {
            const { deps, outLines } = makeMockDeps({
                shellRun: async (command: string[]) => {
                    if (command[0] === "git" && command[1] === "status") return makeShellResult({ stdout: "" });
                    if (command[0] === "gh" && command[1] === "issue")
                        return makeShellResult({ stdout: makeGhIssueResponse() });
                    if (command[0] === "/usr/local/libexec/adda-dev-runtime/bin/resolve-issue-branch") {
                        return makeShellResult({ stdout: makeResolveResponse("feature_branch", "feature/28-test", "42") });
                    }
                    if (command[0] === "git" && command[1] === "checkout") return makeShellResult();
                    if (command[0] === "bash" && command[1] === "/workspace/.adda-init.sh") {
                        return makeShellResult({ stdout: "installed deps\n", stderr: "", exitCode: 0 });
                    }
                    return makeShellResult();
                },
                fileSysFileExists: async (_path: string) => true,
            });

            const code = await new CurrentIssueScript(deps).run(["bun", "current-issue.ts", "switch", "28"]);
            expect(code).toBe(0);

            const out = parseStdoutJson(outLines);
            expect(out.status).toBe("ok");
            const result = out.result as Record<string, unknown>;
            const details = result.details as Record<string, unknown>;
            const hook = details.hook as Record<string, string>;
            expect(hook.status).toBe("ok");
            expect(hook.output).toContain("installed deps");
        });

        test("hook present but fails — exits 1, fail envelope with details.hook.status 'failed', output retained", async () => {
            const { deps, outLines } = makeMockDeps({
                shellRun: async (command: string[]) => {
                    if (command[0] === "git" && command[1] === "status") return makeShellResult({ stdout: "" });
                    if (command[0] === "gh" && command[1] === "issue")
                        return makeShellResult({ stdout: makeGhIssueResponse() });
                    if (command[0] === "/usr/local/libexec/adda-dev-runtime/bin/resolve-issue-branch") {
                        return makeShellResult({ stdout: makeResolveResponse("feature_branch", "feature/28-test", "42") });
                    }
                    if (command[0] === "git" && command[1] === "checkout") return makeShellResult();
                    if (command[0] === "bash" && command[1] === "/workspace/.adda-init.sh") {
                        throw new ScriptShellError("bash /workspace/.adda-init.sh", 1, "partial output\n", "hook error\n");
                    }
                    return makeShellResult();
                },
                fileSysFileExists: async (_path: string) => true,
            });

            const code = await new CurrentIssueScript(deps).run(["bun", "current-issue.ts", "switch", "28"]);
            expect(code).toBe(1);

            const out = parseStdoutJson(outLines);
            expect(out.status).toBe("fail");
            const error = out.error as Record<string, unknown>;
            expect(String(error.message)).toContain("repo init hook failed");
            const details = error.details as Record<string, unknown>;
            const hook = details.hook as Record<string, string>;
            expect(hook.status).toBe("failed");
            expect(hook.output).toContain("partial output");
            expect(hook.output).toContain("hook error");
        });
    });

    describe("show", () => {
        const validStateJson = JSON.stringify({
            id: "42",
            title: "A test issue",
            type: "feature",
            phase: "phase:implement",
            state: "open",
            pr: "99",
            owner: "testowner",
            repo: "testrepo",
            parent: null,
            children: [],
            siblings: [],
        });

        test("no active issue (ENOENT) — exits 0, ok envelope, scalar fields empty, hierarchy keys absent", async () => {
            const { deps, outLines } = makeMockDeps();
            const code = await new CurrentIssueScript(deps).run(["bun", "current-issue.ts", "show"]);
            expect(code).toBe(0);
            const out = parseStdoutJson(outLines);
            expect(out.status).toBe("ok");
            expect(out.error).toBeNull();
            const result = out.result as Record<string, unknown>;
            const issue = result.issue as Record<string, unknown>;
            expect(issue.id).toBe("");
            expect(issue.title).toBe("");
            expect(issue.type).toBe("");
            expect(issue.phase).toBe("");
            expect(issue.state).toBe("");
            expect(issue.pr).toBe("");
            expect("parent" in issue).toBe(false);
            expect("children" in issue).toBe(false);
            expect("siblings" in issue).toBe(false);
            expect(result.details).toEqual({});
        });

        test("active issue — exits 0, ok envelope, scalar fields match state, hierarchy keys absent", async () => {
            const { deps, outLines } = makeMockDeps({
                fileReaderReadFile: async (_path: string) => validStateJson,
            });
            const code = await new CurrentIssueScript(deps).run(["bun", "current-issue.ts", "show"]);
            expect(code).toBe(0);
            const out = parseStdoutJson(outLines);
            expect(out.status).toBe("ok");
            expect(out.error).toBeNull();
            const result = out.result as Record<string, unknown>;
            const issue = result.issue as Record<string, unknown>;
            expect(issue.id).toBe("42");
            expect(issue.title).toBe("A test issue");
            expect(issue.type).toBe("feature");
            expect(issue.phase).toBe("phase:implement");
            expect(issue.state).toBe("open");
            expect(issue.pr).toBe("99");
            expect("parent" in issue).toBe(false);
            expect("children" in issue).toBe(false);
            expect("siblings" in issue).toBe(false);
            expect(result.details).toEqual({});
        });

        test("corrupt state (invalid JSON) — exits 1, fail envelope, error contains 'state file is corrupt'", async () => {
            const { deps, outLines } = makeMockDeps({
                fileReaderReadFile: async (_path: string) => "not json",
            });
            const code = await new CurrentIssueScript(deps).run(["bun", "current-issue.ts", "show"]);
            expect(code).toBe(1);
            const out = parseStdoutJson(outLines);
            expect(out.status).toBe("fail");
            const error = out.error as Record<string, unknown>;
            expect(String(error.message)).toContain("state file is corrupt");
        });

        test("corrupt state (schema mismatch) — exits 1, fail envelope, error contains 'state file is corrupt'", async () => {
            const { deps, outLines } = makeMockDeps({
                fileReaderReadFile: async (_path: string) => JSON.stringify({ foo: "bar" }),
            });
            const code = await new CurrentIssueScript(deps).run(["bun", "current-issue.ts", "show"]);
            expect(code).toBe(1);
            const out = parseStdoutJson(outLines);
            expect(out.status).toBe("fail");
            const error = out.error as Record<string, unknown>;
            expect(String(error.message)).toContain("state file is corrupt");
        });

        test("extra positional arg — exits 2, fail envelope with 'usage: current-issue show [--with-hierarchy]'", async () => {
            const { deps, outLines } = makeMockDeps();
            const code = await new CurrentIssueScript(deps).run(["bun", "current-issue.ts", "show", "42"]);
            expect(code).toBe(2);
            const out = parseStdoutJson(outLines);
            expect(out.status).toBe("fail");
            const error = out.error as Record<string, unknown>;
            expect(String(error.message)).toContain("usage: current-issue show [--with-hierarchy]");
        });

        test("--with-hierarchy flag — parent/children/siblings present in output", async () => {
            const hierarchyState = JSON.stringify({
                id: "42",
                title: "Hierarchy issue",
                type: "feature",
                phase: "phase: implement",
                state: "open",
                pr: "99",
                owner: "testowner",
                repo: "testrepo",
                parent: {
                    number: 10,
                    title: "Parent",
                    state: "open",
                    type: "feature",
                    phase: null,
                    parent: null,
                    labels: ["feature"],
                    owner: "testowner",
                    repo: "testrepo",
                },
                children: [],
                siblings: [
                    {
                        number: 12,
                        title: "Sibling",
                        state: "open",
                        type: "chore",
                        phase: null,
                        parent: 10,
                        labels: ["chore"],
                        owner: "testowner",
                        repo: "testrepo",
                    },
                ],
            });
            const { deps, outLines } = makeMockDeps({
                fileReaderReadFile: async (_path: string) => hierarchyState,
            });
            const code = await new CurrentIssueScript(deps).run(["bun", "current-issue.ts", "show", "--with-hierarchy"]);
            expect(code).toBe(0);
            const out = parseStdoutJson(outLines);
            expect(out.status).toBe("ok");
            expect(out.error).toBeNull();
            const result = out.result as Record<string, unknown>;
            const issue = result.issue as Record<string, unknown>;
            const parent = issue.parent as Record<string, unknown> | null;
            expect(parent).not.toBeNull();
            expect(parent!.number).toBe(10);
            expect(parent!.title).toBe("Parent");
            const siblings = issue.siblings as Array<Record<string, unknown>>;
            expect(siblings).toHaveLength(1);
            expect(siblings[0].number).toBe(12);
            const children = issue.children as Array<Record<string, unknown>>;
            expect(children).toEqual([]);
        });

        test("default show with hierarchy state — hierarchy fields absent from output", async () => {
            const hierarchyState = JSON.stringify({
                id: "42",
                title: "Hierarchy issue",
                type: "feature",
                phase: "phase: implement",
                state: "open",
                pr: "99",
                owner: "testowner",
                repo: "testrepo",
                parent: {
                    number: 10,
                    title: "Parent",
                    state: "open",
                    type: "feature",
                    phase: null,
                    parent: null,
                    labels: ["feature"],
                    owner: "testowner",
                    repo: "testrepo",
                },
                children: [],
                siblings: [
                    {
                        number: 12,
                        title: "Sibling",
                        state: "open",
                        type: "chore",
                        phase: null,
                        parent: 10,
                        labels: ["chore"],
                        owner: "testowner",
                        repo: "testrepo",
                    },
                ],
            });
            const { deps, outLines } = makeMockDeps({
                fileReaderReadFile: async (_path: string) => hierarchyState,
            });
            const code = await new CurrentIssueScript(deps).run(["bun", "current-issue.ts", "show"]);
            expect(code).toBe(0);
            const out = parseStdoutJson(outLines);
            expect(out.status).toBe("ok");
            expect(out.error).toBeNull();
            const result = out.result as Record<string, unknown>;
            const issue = result.issue as Record<string, unknown>;
            expect(issue.id).toBe("42");
            expect("parent" in issue).toBe(false);
            expect("children" in issue).toBe(false);
            expect("siblings" in issue).toBe(false);
        });

        test("--with-hierarchy on non-show subcommand — exits 2, error contains '--with-hierarchy is not valid for'", async () => {
            const { deps, outLines } = makeMockDeps();
            const code = await new CurrentIssueScript(deps).run(["bun", "current-issue.ts", "sync", "--with-hierarchy"]);
            expect(code).toBe(2);
            const out = parseStdoutJson(outLines);
            expect(out.status).toBe("fail");
            const error = out.error as Record<string, unknown>;
            expect(String(error.message)).toContain("--with-hierarchy is not valid for 'sync'");
        });

        test("state file without hierarchy fields is rejected — exits 1, fail envelope", async () => {
            const oldStateJson = JSON.stringify({
                id: "42",
                title: "A test issue",
                type: "feature",
                phase: "phase:implement",
                state: "open",
                pr: "99",
                // missing parent, children, siblings
            });
            const { deps, outLines } = makeMockDeps({
                fileReaderReadFile: async (_path: string) => oldStateJson,
            });
            const code = await new CurrentIssueScript(deps).run(["bun", "current-issue.ts", "show"]);
            expect(code).toBe(1);
            const out = parseStdoutJson(outLines);
            expect(out.status).toBe("fail");
            const error = out.error as Record<string, unknown>;
            expect(String(error.message)).toContain("state file is corrupt");
        });

        test("state file without owner/repo fields is rejected — exits 1, fail envelope, error contains 'state file is corrupt'", async () => {
            const oldStateJson = JSON.stringify({
                id: "42",
                title: "A test issue",
                type: "feature",
                phase: "phase:implement",
                state: "open",
                pr: "99",
                // missing owner, repo
                parent: null,
                children: [],
                siblings: [],
            });
            const { deps, outLines } = makeMockDeps({
                fileReaderReadFile: async (_path: string) => oldStateJson,
            });
            const code = await new CurrentIssueScript(deps).run(["bun", "current-issue.ts", "show"]);
            expect(code).toBe(1);
            const out = parseStdoutJson(outLines);
            expect(out.status).toBe("fail");
            const error = out.error as Record<string, unknown>;
            expect(String(error.message)).toContain("state file is corrupt");
        });
    });

    describe("sync", () => {
        const validStateJson = JSON.stringify({
            id: "28",
            title: "A test issue",
            type: "feature",
            phase: "phase:implement",
            state: "open",
            pr: "42",
            owner: "testowner",
            repo: "testrepo",
            parent: null,
            children: [],
            siblings: [],
        });

        test("no active issue (ENOENT) — exits 1, fail envelope, error contains 'no active issue to sync'", async () => {
            const { deps, outLines } = makeMockDeps();
            const code = await new CurrentIssueScript(deps).run(["bun", "current-issue.ts", "sync"]);
            expect(code).toBe(1);
            const out = parseStdoutJson(outLines);
            expect(out.status).toBe("fail");
            expect(out.result).toBeNull();
            const error = out.error as Record<string, unknown>;
            expect(String(error.message)).toContain("no active issue to sync");
        });

        test("active issue with empty id — exits 1, fail envelope, error contains 'no active issue to sync'", async () => {
            const emptyIdState = JSON.stringify({
                id: "",
                title: "A test issue",
                type: "feature",
                phase: "phase:implement",
                state: "open",
                pr: "42",
                owner: "testowner",
                repo: "testrepo",
                parent: null,
                children: [],
                siblings: [],
            });
            const { deps, outLines } = makeMockDeps({
                fileReaderReadFile: async (_path: string) => emptyIdState,
            });
            const code = await new CurrentIssueScript(deps).run(["bun", "current-issue.ts", "sync"]);
            expect(code).toBe(1);
            const out = parseStdoutJson(outLines);
            expect(out.status).toBe("fail");
            expect(out.result).toBeNull();
            const error = out.error as Record<string, unknown>;
            expect(String(error.message)).toContain("no active issue to sync");
        });

        test("active issue with valid id — exits 0, ok envelope, issue.id matches state", async () => {
            const { deps, outLines } = makeMockDeps({
                fileReaderReadFile: async (_path: string) => validStateJson,
            });
            const code = await new CurrentIssueScript(deps).run(["bun", "current-issue.ts", "sync"]);
            expect(code).toBe(0);
            const out = parseStdoutJson(outLines);
            expect(out.status).toBe("ok");
            expect(out.error).toBeNull();
            const result = out.result as Record<string, unknown>;
            const issue = result.issue as Record<string, string>;
            expect(issue.id).toBe("28");
        });
    });

    describe("sync --issue-state-only", () => {
        const validStateJson = JSON.stringify({
            id: "28",
            title: "A test issue",
            type: "feature",
            phase: "phase:implement",
            state: "open",
            pr: "42",
            owner: "testowner",
            repo: "testrepo",
            parent: null,
            children: [],
            siblings: [],
        });

        test("sync --issue-state-only succeeds — exit 0, ok envelope, issue.id matches state, no git calls made", async () => {
            const shellRunMock = mock(async (command: string[]) => {
                if (command[0] === "gh" && command[1] === "issue") {
                    return makeShellResult({ stdout: makeGhIssueResponse() });
                }
                if (command[0] === "/usr/local/libexec/adda-dev-runtime/bin/resolve-issue-branch") {
                    return makeShellResult({ stdout: makeResolveResponse("feature_branch", "feature/28-test", "42") });
                }
                if (command[0] === "gh" && command[1] === "api") {
                    return makeShellResult({ stdout: defaultHierarchyApiResponse(command[command.length - 1] as string) });
                }
                return makeShellResult();
            });

            const { deps, outLines } = makeMockDeps({
                shellRun: shellRunMock,
                fileReaderReadFile: async (_path: string) => validStateJson,
            });

            const code = await new CurrentIssueScript(deps).run(["bun", "current-issue.ts", "sync", "--issue-state-only"]);
            expect(code).toBe(0);

            const out = parseStdoutJson(outLines);
            expect(out.status).toBe("ok");
            expect(out.error).toBeNull();
            const result = out.result as Record<string, unknown>;
            const issue = result.issue as Record<string, string>;
            expect(issue.id).toBe("28");

            // Verify git operations were NOT called
            expect(shellRunMock).not.toHaveBeenCalledWith(expect.arrayContaining(["git", "status", "--porcelain"]));
            expect(shellRunMock).not.toHaveBeenCalledWith(expect.arrayContaining(["git", "checkout"]));
            expect(shellRunMock).not.toHaveBeenCalledWith(expect.arrayContaining(["git", "pull"]));
            // Verify bash (repo init hook) was NOT called
            expect(shellRunMock).not.toHaveBeenCalledWith(expect.arrayContaining(["bash"]));
        });

        test("no active issue with --issue-state-only — exits 1, fail envelope, error contains 'no active issue to sync'", async () => {
            const { deps, outLines } = makeMockDeps();
            const code = await new CurrentIssueScript(deps).run(["bun", "current-issue.ts", "sync", "--issue-state-only"]);
            expect(code).toBe(1);
            const out = parseStdoutJson(outLines);
            expect(out.status).toBe("fail");
            expect(out.result).toBeNull();
            const error = out.error as Record<string, unknown>;
            expect(String(error.message)).toContain("no active issue to sync");
        });

        test("switch --issue-state-only is rejected — exits 2, ScriptArgsError", async () => {
            const { deps, outLines } = makeMockDeps();
            const code = await new CurrentIssueScript(deps).run([
                "bun",
                "current-issue.ts",
                "switch",
                "28",
                "--issue-state-only",
            ]);
            expect(code).toBe(2);
            const out = parseStdoutJson(outLines);
            expect(out.status).toBe("fail");
            const error = out.error as Record<string, unknown>;
            expect(String(error.message)).toContain("--issue-state-only is not valid for 'switch'");
        });
    });

    describe("clear", () => {
        test("no state file — no-op envelope, exit 0, no git calls made", async () => {
            const shellRunMock = mock(async (_command: string[]) => makeShellResult());
            const { deps, outLines } = makeMockDeps({
                shellRun: shellRunMock,
                fileSysFileExists: async (_path: string) => false,
            });

            const code = await new CurrentIssueScript(deps).run(["bun", "current-issue.ts", "clear"]);
            expect(code).toBe(0);

            const out = parseStdoutJson(outLines);
            expect(out.status).toBe("ok");
            expect(out.error).toBeNull();
            const result = out.result as Record<string, unknown>;
            const details = result.details as Record<string, string>;
            expect(details.resolution).toBe("no-op");
            expect(shellRunMock).not.toHaveBeenCalled();
        });

        test("state file present, dirty tree — fail envelope, exit 1", async () => {
            const deleteFileMock = mock(async (_path: string) => {});
            const { deps, outLines } = makeMockDeps({
                shellRun: async (command: string[]) => {
                    if (command[0] === "git" && command[1] === "status") {
                        return makeShellResult({ stdout: " M some-file.ts\n" });
                    }
                    return makeShellResult();
                },
                fileSysFileExists: async (_path: string) => true,
                fileSysDeleteFile: deleteFileMock,
            });

            const code = await new CurrentIssueScript(deps).run(["bun", "current-issue.ts", "clear"]);
            expect(code).toBe(1);

            const out = parseStdoutJson(outLines);
            expect(out.status).toBe("fail");
            const error = out.error as Record<string, unknown>;
            expect(String(error.message)).toContain("working tree is dirty");
            expect(deleteFileMock).not.toHaveBeenCalled();
        });

        test("state file present, clean tree, git checkout main fails — fail envelope, exit 1, stderr forwarded", async () => {
            const deleteFileMock = mock(async (_path: string) => {});
            const { deps, outLines } = makeMockDeps({
                shellRun: async (command: string[]) => {
                    if (command[0] === "git" && command[1] === "status") {
                        return makeShellResult({ stdout: "" });
                    }
                    if (command[0] === "git" && command[1] === "checkout") {
                        throw new ScriptShellError("git checkout main", 1, "", "error: pathspec 'main' did not match");
                    }
                    return makeShellResult();
                },
                fileSysFileExists: async (_path: string) => true,
                fileSysDeleteFile: deleteFileMock,
            });

            const code = await new CurrentIssueScript(deps).run(["bun", "current-issue.ts", "clear"]);
            expect(code).toBe(1);

            const out = parseStdoutJson(outLines);
            expect(out.status).toBe("fail");
            const error = out.error as Record<string, unknown>;
            const details = error.details as Record<string, unknown>;
            expect(String(details.cmd)).toContain("git checkout");
            expect(String(details.stderr)).toContain("pathspec");
            expect(deleteFileMock).not.toHaveBeenCalled();
        });

        test("happy path — deleteState called, ok envelope with branch: main and resolution: main, exit 0", async () => {
            const deleteFileMock = mock(async (_path: string) => {});
            const { deps, outLines } = makeMockDeps({
                shellRun: async (command: string[]) => {
                    if (command[0] === "git" && command[1] === "status") {
                        return makeShellResult({ stdout: "" });
                    }
                    if (command[0] === "git" && command[1] === "checkout") {
                        return makeShellResult();
                    }
                    return makeShellResult();
                },
                fileSysFileExists: async (path: string) => (path === "/run/adda/.adda-current-issue" ? true : false),
                fileSysDeleteFile: deleteFileMock,
            });

            const code = await new CurrentIssueScript(deps).run(["bun", "current-issue.ts", "clear"]);
            expect(code).toBe(0);

            const out = parseStdoutJson(outLines);
            expect(out.status).toBe("ok");
            expect(out.error).toBeNull();

            const result = out.result as Record<string, unknown>;
            const issue = result.issue as Record<string, string>;
            expect(issue.id).toBe("");
            expect(issue.title).toBe("");

            const details = result.details as Record<string, unknown>;
            expect(details.branch).toBe("main");
            expect(details.resolution).toBe("main");
            expect(details.hook).toMatchObject({ status: "absent" });

            expect(deleteFileMock).toHaveBeenCalledTimes(1);
            expect(deleteFileMock).toHaveBeenCalledWith("/run/adda/.adda-current-issue");
        });
    });

    describe("clear — hook statuses", () => {
        const STATE_PATH = "/run/adda/.adda-current-issue";
        const ADDA_INIT_HOOK_PATH = "/workspace/.adda-init.sh";

        const defaultShellForClear = async (command: string[]): Promise<ShellResult> => {
            if (command[0] === "git" && command[1] === "status") return makeShellResult({ stdout: "" });
            if (command[0] === "git" && command[1] === "checkout") return makeShellResult();
            return makeShellResult();
        };

        test("hook absent — exits 0, ok envelope, details.hook.status is 'absent'", async () => {
            const { deps, outLines } = makeMockDeps({
                shellRun: defaultShellForClear,
                fileSysFileExists: async (path: string) => path === STATE_PATH,
            });

            const code = await new CurrentIssueScript(deps).run(["bun", "current-issue.ts", "clear"]);
            expect(code).toBe(0);

            const out = parseStdoutJson(outLines);
            expect(out.status).toBe("ok");
            const result = out.result as Record<string, unknown>;
            const details = result.details as Record<string, unknown>;
            expect(details.hook).toMatchObject({ status: "absent" });
        });

        test("hook present and succeeds — exits 0, ok envelope, details.hook.status is 'ok', output captured", async () => {
            const { deps, outLines } = makeMockDeps({
                shellRun: async (command: string[]) => {
                    if (command[0] === "git" && command[1] === "status") return makeShellResult({ stdout: "" });
                    if (command[0] === "git" && command[1] === "checkout") return makeShellResult();
                    if (command[0] === "bash" && command[1] === ADDA_INIT_HOOK_PATH) {
                        return makeShellResult({ stdout: "installed deps\n", stderr: "", exitCode: 0 });
                    }
                    return makeShellResult();
                },
                fileSysFileExists: async (path: string) => path === STATE_PATH || path === ADDA_INIT_HOOK_PATH,
            });

            const code = await new CurrentIssueScript(deps).run(["bun", "current-issue.ts", "clear"]);
            expect(code).toBe(0);

            const out = parseStdoutJson(outLines);
            expect(out.status).toBe("ok");
            const result = out.result as Record<string, unknown>;
            const details = result.details as Record<string, unknown>;
            const hook = details.hook as Record<string, string>;
            expect(hook.status).toBe("ok");
            expect(hook.output).toContain("installed deps");
        });

        test("hook present but fails — exits 1, fail envelope, details.hook.status is 'failed', output retained", async () => {
            const { deps, outLines } = makeMockDeps({
                shellRun: async (command: string[]) => {
                    if (command[0] === "git" && command[1] === "status") return makeShellResult({ stdout: "" });
                    if (command[0] === "git" && command[1] === "checkout") return makeShellResult();
                    if (command[0] === "bash" && command[1] === ADDA_INIT_HOOK_PATH) {
                        throw new ScriptShellError(`bash ${ADDA_INIT_HOOK_PATH}`, 1, "partial output\n", "hook error\n");
                    }
                    return makeShellResult();
                },
                fileSysFileExists: async (path: string) => path === STATE_PATH || path === ADDA_INIT_HOOK_PATH,
            });

            const code = await new CurrentIssueScript(deps).run(["bun", "current-issue.ts", "clear"]);
            expect(code).toBe(1);

            const out = parseStdoutJson(outLines);
            expect(out.status).toBe("fail");
            const error = out.error as Record<string, unknown>;
            expect(String(error.message)).toContain("repo init hook failed");
            const details = error.details as Record<string, unknown>;
            const hook = details.hook as Record<string, string>;
            expect(hook.status).toBe("failed");
            expect(hook.output).toContain("partial output");
            expect(hook.output).toContain("hook error");
        });
    });

    describe("get", () => {
        const validStateJson = JSON.stringify({
            id: "42",
            title: "A test issue",
            type: "feature",
            phase: "phase: triage",
            state: "open",
            pr: "99",
            owner: "testowner",
            repo: "testrepo",
            parent: null,
            children: [],
            siblings: [],
        });

        test("no state file (ENOENT) — empty output, exit 0", async () => {
            const { deps, outLines } = makeMockDeps();
            const code = await new CurrentIssueScript(deps).run(["bun", "current-issue.ts", "get", "id"]);
            expect(code).toBe(0);
            expect(outLines.join("").trim()).toBe("");
        });

        test("corrupt state (invalid JSON) — empty output, exit 0", async () => {
            const { deps, outLines } = makeMockDeps({
                fileReaderReadFile: async (_path: string) => "not json",
            });
            const code = await new CurrentIssueScript(deps).run(["bun", "current-issue.ts", "get", "id"]);
            expect(code).toBe(0);
            expect(outLines.join("").trim()).toBe("");
        });

        test("corrupt state (schema mismatch) — empty output, exit 0", async () => {
            const { deps, outLines } = makeMockDeps({
                fileReaderReadFile: async (_path: string) => JSON.stringify({ foo: "bar" }),
            });
            const code = await new CurrentIssueScript(deps).run(["bun", "current-issue.ts", "get", "id"]);
            expect(code).toBe(0);
            expect(outLines.join("").trim()).toBe("");
        });

        test("fileReader throws non-ENOENT (EACCES) — empty output, exit 0", async () => {
            const { deps, outLines } = makeMockDeps({
                fileReaderReadFile: async (_path: string) => {
                    throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
                },
            });
            const code = await new CurrentIssueScript(deps).run(["bun", "current-issue.ts", "get", "id"]);
            expect(code).toBe(0);
            expect(outLines.join("").trim()).toBe("");
        });

        test("no field arg — exits 2, fail envelope", async () => {
            const { deps, outLines } = makeMockDeps();
            const code = await new CurrentIssueScript(deps).run(["bun", "current-issue.ts", "get"]);
            expect(code).toBe(2);
            const out = parseStdoutJson(outLines);
            expect(out.status).toBe("fail");
            const error = out.error as Record<string, unknown>;
            expect(String(error.message)).toContain("usage: current-issue get <field>");
        });

        test("unknown field — empty output, exit 0", async () => {
            const { deps, outLines } = makeMockDeps({
                fileReaderReadFile: async (_path: string) => validStateJson,
            });
            const code = await new CurrentIssueScript(deps).run(["bun", "current-issue.ts", "get", "unknownfield"]);
            expect(code).toBe(0);
            expect(outLines.join("").trim()).toBe("");
        });

        test("field 'id' — output '42', exit 0", async () => {
            const { deps, outLines } = makeMockDeps({
                fileReaderReadFile: async (_path: string) => validStateJson,
            });
            const code = await new CurrentIssueScript(deps).run(["bun", "current-issue.ts", "get", "id"]);
            expect(code).toBe(0);
            expect(outLines.join("").trim()).toBe("42");
        });

        test("field 'title' — output 'A test issue', exit 0", async () => {
            const { deps, outLines } = makeMockDeps({
                fileReaderReadFile: async (_path: string) => validStateJson,
            });
            const code = await new CurrentIssueScript(deps).run(["bun", "current-issue.ts", "get", "title"]);
            expect(code).toBe(0);
            expect(outLines.join("").trim()).toBe("A test issue");
        });

        test("field 'type' — output 'feature', exit 0", async () => {
            const { deps, outLines } = makeMockDeps({
                fileReaderReadFile: async (_path: string) => validStateJson,
            });
            const code = await new CurrentIssueScript(deps).run(["bun", "current-issue.ts", "get", "type"]);
            expect(code).toBe(0);
            expect(outLines.join("").trim()).toBe("feature");
        });

        test("field 'phase' — output 'phase: triage', exit 0", async () => {
            const { deps, outLines } = makeMockDeps({
                fileReaderReadFile: async (_path: string) => validStateJson,
            });
            const code = await new CurrentIssueScript(deps).run(["bun", "current-issue.ts", "get", "phase"]);
            expect(code).toBe(0);
            expect(outLines.join("").trim()).toBe("phase: triage");
        });

        test("field 'state' — output 'OPEN', exit 0", async () => {
            const { deps, outLines } = makeMockDeps({
                fileReaderReadFile: async (_path: string) => validStateJson,
            });
            const code = await new CurrentIssueScript(deps).run(["bun", "current-issue.ts", "get", "state"]);
            expect(code).toBe(0);
            expect(outLines.join("").trim()).toBe("open");
        });

        test("field 'pr' — output '99', exit 0", async () => {
            const { deps, outLines } = makeMockDeps({
                fileReaderReadFile: async (_path: string) => validStateJson,
            });
            const code = await new CurrentIssueScript(deps).run(["bun", "current-issue.ts", "get", "pr"]);
            expect(code).toBe(0);
            expect(outLines.join("").trim()).toBe("99");
        });

        test("field with empty value in state — empty output, exit 0", async () => {
            const stateWithEmptyPr = JSON.stringify({
                id: "42",
                title: "A test issue",
                type: "feature",
                phase: "phase: triage",
                state: "open",
                pr: "",
                owner: "testowner",
                repo: "testrepo",
                parent: null,
                children: [],
                siblings: [],
            });
            const { deps, outLines } = makeMockDeps({
                fileReaderReadFile: async (_path: string) => stateWithEmptyPr,
            });
            const code = await new CurrentIssueScript(deps).run(["bun", "current-issue.ts", "get", "pr"]);
            expect(code).toBe(0);
            expect(outLines.join("").trim()).toBe("");
        });

        test("field 'parent' with parent: null — empty output, exit 0", async () => {
            const { deps, outLines } = makeMockDeps({
                fileReaderReadFile: async (_path: string) => validStateJson,
            });
            const code = await new CurrentIssueScript(deps).run(["bun", "current-issue.ts", "get", "parent"]);
            expect(code).toBe(0);
            expect(outLines.join("").trim()).toBe("");
        });

        test("field 'parent' with non-null parent object — empty output, exit 0", async () => {
            const stateWithParent = JSON.stringify({
                id: "429",
                title: "current-issue get silently drops non-scalar fields",
                type: "bug",
                phase: "phase: triage",
                state: "open",
                pr: "",
                owner: "testowner",
                repo: "testrepo",
                parent: {
                    number: 420,
                    title: "current-issue script",
                    state: "open",
                    type: "feature",
                    phase: "phase: triage",
                    parent: null,
                    labels: ["feature", "phase: triage"],
                },
                children: [],
                siblings: [],
            });
            const { deps, outLines } = makeMockDeps({
                fileReaderReadFile: async (_path: string) => stateWithParent,
            });
            const code = await new CurrentIssueScript(deps).run(["bun", "current-issue.ts", "get", "parent"]);
            expect(code).toBe(0);
            expect(outLines.join("").trim()).toBe("");
        });

        test("field 'children' with children: [] — empty output, exit 0", async () => {
            const { deps, outLines } = makeMockDeps({
                fileReaderReadFile: async (_path: string) => validStateJson,
            });
            const code = await new CurrentIssueScript(deps).run(["bun", "current-issue.ts", "get", "children"]);
            expect(code).toBe(0);
            expect(outLines.join("").trim()).toBe("");
        });

        test("field 'siblings' with non-empty siblings array — empty output, exit 0", async () => {
            const stateWithSiblings = JSON.stringify({
                id: "429",
                title: "current-issue get silently drops non-scalar fields",
                type: "bug",
                phase: "phase: triage",
                state: "open",
                pr: "",
                owner: "testowner",
                repo: "testrepo",
                parent: null,
                children: [],
                siblings: [
                    {
                        number: 413,
                        title: "Show current repo in current-issue and status line",
                        state: "closed",
                        type: "feature",
                        phase: "phase: triage",
                        parent: 420,
                        labels: ["feature", "phase: triage"],
                    },
                ],
            });
            const { deps, outLines } = makeMockDeps({
                fileReaderReadFile: async (_path: string) => stateWithSiblings,
            });
            const code = await new CurrentIssueScript(deps).run(["bun", "current-issue.ts", "get", "siblings"]);
            expect(code).toBe(0);
            expect(outLines.join("").trim()).toBe("");
        });
    });

    describe("IssueStateStore", () => {
        const validStateJson = JSON.stringify({
            id: "42",
            title: "A test issue",
            type: "feature",
            phase: "phase:implement",
            state: "open",
            pr: "99",
            owner: "testowner",
            repo: "testrepo",
            parent: null,
            children: [],
            siblings: [],
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
                expect(result?.state).toBe("open");
                expect(result?.pr).toBe("99");
            });

            test("fileReader returns invalid JSON — throws ScriptError with 'state file is corrupt'", async () => {
                const { deps } = makeMockDeps({
                    fileReaderReadFile: async (_path: string) => "not valid json {{{",
                });
                const script: IssueStateStore = new CurrentIssueScript(deps);
                await expect(script.readState()).rejects.toMatchObject({
                    message: expect.stringContaining("state file is corrupt"),
                });
            });

            test("fileReader returns valid JSON but wrong schema — throws ScriptError with 'state file is corrupt'", async () => {
                const { deps } = makeMockDeps({
                    fileReaderReadFile: async (_path: string) => JSON.stringify({ foo: "bar" }),
                });
                const script: IssueStateStore = new CurrentIssueScript(deps);
                await expect(script.readState()).rejects.toMatchObject({
                    message: expect.stringContaining("state file is corrupt"),
                });
            });
        });

        describe("SilentStore — guard methods", () => {
            test("writeState — throws 'not supported'", async () => {
                const { deps } = makeMockDeps();
                const store = new SilentStore(deps);
                await expect(
                    store.writeState({
                        id: "1",
                        title: "t",
                        type: "feature",
                        phase: "p",
                        state: "open",
                        pr: "",
                        owner: "testowner",
                        repo: "testrepo",
                        parent: null,
                        children: [],
                        siblings: [],
                    }),
                ).rejects.toThrow("not supported");
            });

            test("deleteState — throws 'not supported'", async () => {
                const { deps } = makeMockDeps();
                const store = new SilentStore(deps);
                await expect(store.deleteState()).rejects.toThrow("not supported");
            });

            test("stateExists — throws 'not supported'", async () => {
                const { deps } = makeMockDeps();
                const store = new SilentStore(deps);
                await expect(store.stateExists()).rejects.toThrow("not supported");
            });
        });

        describe("deleteState", () => {
            test("calls fileSys.deleteFile with STATE_PATH exactly once", async () => {
                const deleteFileMock = mock(async (_path: string) => {});
                const { deps } = makeMockDeps({ fileSysDeleteFile: deleteFileMock });
                const script: IssueStateStore = new CurrentIssueScript(deps);
                await script.deleteState();
                expect(deleteFileMock).toHaveBeenCalledTimes(1);
                expect(deleteFileMock).toHaveBeenCalledWith("/run/adda/.adda-current-issue");
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
