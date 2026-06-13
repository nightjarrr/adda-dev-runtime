import { describe, expect, mock, test } from "bun:test";
import type { Shell, ShellDep, ShellResult, StdioDep } from "../../lib/index";
import { ScriptStructuredError } from "../../lib/index";
import type { IssueState, IssueStateStore } from "./types";
import { executeBranchEnsure, executeBranchVerify } from "./branch";

// --- Helpers ---

function makeShellResult(overrides: Partial<ShellResult> = {}): ShellResult {
    return { stdout: "", stderr: "", exitCode: 0, ...overrides };
}

function makeResolveResponse(status: string, branch = "", pr = "", details = ""): string {
    return JSON.stringify({ status, branch, pr, details });
}

const RESOLVE_BIN = "/usr/local/libexec/adda-dev-runtime/bin/resolve-issue-branch";

const DEFAULT_STATE: IssueState = {
    id: "270",
    title: "Branch lifecycle tooling for SDLC roles",
    type: "chore",
    phase: "",
    state: "OPEN",
    pr: "",
};

// --- Mock factory ---

function makeMockStore(state: IssueState | null = DEFAULT_STATE): IssueStateStore {
    return {
        readState: mock(async () => state),
        writeState: mock(async (_s: IssueState) => {}),
        deleteState: mock(async () => {}),
        stateExists: mock(async () => state !== null),
    };
}

function makeMockDeps(shellRun?: (command: string[]) => Promise<ShellResult>): {
    deps: ShellDep & StdioDep;
    errLines: string[];
} {
    const defaultShellRun = async (command: string[]): Promise<ShellResult> => {
        if (command[0] === RESOLVE_BIN) {
            return makeShellResult({
                stdout: makeResolveResponse("feature_branch", "chore/270-branch-lifecycle-tooling-for-sdlc-roles"),
            });
        }
        if (command[0] === "git" && command[1] === "branch") {
            return makeShellResult({ stdout: "chore/270-branch-lifecycle-tooling-for-sdlc-roles\n" });
        }
        return makeShellResult();
    };

    const mockShell: Shell = {
        run: mock(shellRun ?? defaultShellRun),
        runSh: mock(async (_cmd: string) => makeShellResult()),
    };

    const errLines: string[] = [];

    const deps: ShellDep & StdioDep = {
        shell: mockShell,
        stdio: {
            stdin: { text: mock(async () => "") },
            stdout: { write: mock(() => {}) },
            stderr: {
                write: mock((t: string) => {
                    errLines.push(t);
                }),
            },
        },
    };

    return { deps, errLines };
}

// --- executeBranchEnsure tests ---

describe("executeBranchEnsure", () => {
    test("no stored issue — throws CurrentIssueError with 'no current issue set'", async () => {
        const { deps } = makeMockDeps();
        const store = makeMockStore(null);
        const err = await executeBranchEnsure(deps, store).catch((e) => e);
        expect(err).toBeInstanceOf(ScriptStructuredError);
        expect(err.message).toContain("no current issue set");
    });

    test("resolve-issue-branch exits non-zero — throws CurrentIssueError", async () => {
        const { deps } = makeMockDeps(async (command) => {
            if (command[0] === RESOLVE_BIN) {
                return makeShellResult({ stdout: "", stderr: "some error", exitCode: 1 });
            }
            return makeShellResult();
        });
        const store = makeMockStore();
        await expect(executeBranchEnsure(deps, store)).rejects.toBeInstanceOf(ScriptStructuredError);
    });

    test("resolve-issue-branch returns invalid JSON — throws CurrentIssueError", async () => {
        const { deps } = makeMockDeps(async (command) => {
            if (command[0] === RESOLVE_BIN) {
                return makeShellResult({ stdout: "not valid json{{", exitCode: 0 });
            }
            return makeShellResult();
        });
        const store = makeMockStore();
        await expect(executeBranchEnsure(deps, store)).rejects.toBeInstanceOf(ScriptStructuredError);
    });

    test("resolve-issue-branch returns ambiguous — throws CurrentIssueError with 'ambiguous'", async () => {
        const { deps } = makeMockDeps(async (command) => {
            if (command[0] === RESOLVE_BIN) {
                return makeShellResult({ stdout: makeResolveResponse("ambiguous", "", "", "two branches"), exitCode: 0 });
            }
            return makeShellResult();
        });
        const store = makeMockStore();
        const err = await executeBranchEnsure(deps, store).catch((e) => e);
        expect(err).toBeInstanceOf(ScriptStructuredError);
        expect(err.message).toContain("ambiguous");
    });

    test("feature_branch + current matches — returns success envelope with action: none", async () => {
        const { deps } = makeMockDeps(async (command) => {
            if (command[0] === RESOLVE_BIN) {
                return makeShellResult({ stdout: makeResolveResponse("feature_branch", "chore/270-my-branch") });
            }
            if (command[0] === "git" && command[1] === "branch") {
                return makeShellResult({ stdout: "chore/270-my-branch\n" });
            }
            return makeShellResult();
        });
        const store = makeMockStore();
        const result = await executeBranchEnsure(deps, store);
        expect(result.status).toBe("success");
        expect(result.details.action).toBe("none");
        expect(result.details.branch).toBe("chore/270-my-branch");
    });

    test("feature_branch + current doesn't match — throws CurrentIssueError with expected branch info", async () => {
        const { deps } = makeMockDeps(async (command) => {
            if (command[0] === RESOLVE_BIN) {
                return makeShellResult({ stdout: makeResolveResponse("feature_branch", "chore/270-my-branch") });
            }
            if (command[0] === "git" && command[1] === "branch") {
                return makeShellResult({ stdout: "some-other-branch\n" });
            }
            return makeShellResult();
        });
        const store = makeMockStore();
        const err = await executeBranchEnsure(deps, store).catch((e) => e);
        expect(err).toBeInstanceOf(ScriptStructuredError);
        expect(err.message).toContain("chore/270-my-branch");
        expect(err.message).toContain("some-other-branch");
    });

    test("main + current is not main — throws CurrentIssueError with expected/actual branch info", async () => {
        const { deps } = makeMockDeps(async (command) => {
            if (command[0] === RESOLVE_BIN) {
                return makeShellResult({ stdout: makeResolveResponse("main") });
            }
            if (command[0] === "git" && command[1] === "branch") {
                return makeShellResult({ stdout: "some-other-branch\n" });
            }
            return makeShellResult();
        });
        const store = makeMockStore();
        const err = await executeBranchEnsure(deps, store).catch((e) => e);
        expect(err).toBeInstanceOf(ScriptStructuredError);
        expect(err.message).toContain("some-other-branch");
    });

    test("main + current is main, normal title — returns success envelope with action: created, correct branch name", async () => {
        const ghDevelopCalls: string[][] = [];
        const { deps } = makeMockDeps(async (command) => {
            if (command[0] === RESOLVE_BIN) {
                return makeShellResult({ stdout: makeResolveResponse("main") });
            }
            if (command[0] === "git" && command[1] === "branch") {
                return makeShellResult({ stdout: "main\n" });
            }
            if (command[0] === "gh" && command[1] === "issue" && command[2] === "develop") {
                ghDevelopCalls.push(command);
                return makeShellResult();
            }
            return makeShellResult();
        });
        const store = makeMockStore();
        const result = await executeBranchEnsure(deps, store);
        expect(result.status).toBe("success");
        expect(result.details.action).toBe("created");
        expect(result.details.branch).toBe("chore/270-branch-lifecycle-tooling-for-sdlc-roles");
        expect(ghDevelopCalls.length).toBe(1);
        expect(ghDevelopCalls[0]).toContain("chore/270-branch-lifecycle-tooling-for-sdlc-roles");
        expect(ghDevelopCalls[0]).toContain("270");
        expect(ghDevelopCalls[0]).toContain("--checkout");
    });

    test("main + current is main, degenerate title (all Unicode) — returns success with action: created, warning present", async () => {
        const { deps } = makeMockDeps(async (command) => {
            if (command[0] === RESOLVE_BIN) {
                return makeShellResult({ stdout: makeResolveResponse("main") });
            }
            if (command[0] === "git" && command[1] === "branch") {
                return makeShellResult({ stdout: "main\n" });
            }
            return makeShellResult();
        });
        const store = makeMockStore({ ...DEFAULT_STATE, title: "😀🎉✨" });
        const result = await executeBranchEnsure(deps, store);
        expect(result.status).toBe("success");
        expect(result.details.action).toBe("created");
        expect(typeof result.details.warning).toBe("string");
        expect(String(result.details.branch)).toMatch(/^chore\/270-[a-z0-9]{8}$/);
    });

    test("gh issue develop fails — forwards stderr and throws CurrentIssueError", async () => {
        const { deps, errLines } = makeMockDeps(async (command) => {
            if (command[0] === RESOLVE_BIN) {
                return makeShellResult({ stdout: makeResolveResponse("main") });
            }
            if (command[0] === "git" && command[1] === "branch") {
                return makeShellResult({ stdout: "main\n" });
            }
            if (command[0] === "gh") {
                return makeShellResult({ stdout: "", stderr: "gh error output", exitCode: 1 });
            }
            return makeShellResult();
        });
        const store = makeMockStore();
        await expect(executeBranchEnsure(deps, store)).rejects.toBeInstanceOf(ScriptStructuredError);
        expect(errLines.join("")).toContain("gh error output");
    });

    test("git branch --show-current fails — forwards stderr and throws CurrentIssueError", async () => {
        const { deps, errLines } = makeMockDeps(async (command) => {
            if (command[0] === RESOLVE_BIN) {
                return makeShellResult({ stdout: makeResolveResponse("feature_branch", "chore/270-my-branch") });
            }
            if (command[0] === "git" && command[1] === "branch") {
                return makeShellResult({ stdout: "", stderr: "fatal: not a git repository", exitCode: 1 });
            }
            return makeShellResult();
        });
        const store = makeMockStore();
        const err = await executeBranchEnsure(deps, store).catch((e) => e);
        expect(err).toBeInstanceOf(ScriptStructuredError);
        expect(errLines.join("")).toContain("fatal: not a git repository");
        expect(err.message).toContain("git branch --show-current failed");
    });
});

// --- executeBranchVerify tests ---

describe("executeBranchVerify", () => {
    test("no stored issue — throws CurrentIssueError with 'no current issue set'", async () => {
        const { deps } = makeMockDeps();
        const store = makeMockStore(null);
        const err = await executeBranchVerify(deps, store).catch((e) => e);
        expect(err).toBeInstanceOf(ScriptStructuredError);
        expect(err.message).toContain("no current issue set");
    });

    test("resolve-issue-branch exits non-zero — throws CurrentIssueError", async () => {
        const { deps } = makeMockDeps(async (command) => {
            if (command[0] === RESOLVE_BIN) {
                return makeShellResult({ stdout: "", stderr: "some error", exitCode: 1 });
            }
            return makeShellResult();
        });
        const store = makeMockStore();
        await expect(executeBranchVerify(deps, store)).rejects.toBeInstanceOf(ScriptStructuredError);
    });

    test("resolve-issue-branch returns main — throws CurrentIssueError with 'no feature branch linked'", async () => {
        const { deps } = makeMockDeps(async (command) => {
            if (command[0] === RESOLVE_BIN) {
                return makeShellResult({ stdout: makeResolveResponse("main") });
            }
            return makeShellResult();
        });
        const store = makeMockStore();
        const err = await executeBranchVerify(deps, store).catch((e) => e);
        expect(err).toBeInstanceOf(ScriptStructuredError);
        expect(err.message).toContain("no feature branch linked");
    });

    test("feature_branch + matches current — returns success envelope with branch", async () => {
        const { deps } = makeMockDeps(async (command) => {
            if (command[0] === RESOLVE_BIN) {
                return makeShellResult({ stdout: makeResolveResponse("feature_branch", "chore/270-my-branch") });
            }
            if (command[0] === "git" && command[1] === "branch") {
                return makeShellResult({ stdout: "chore/270-my-branch\n" });
            }
            return makeShellResult();
        });
        const store = makeMockStore();
        const result = await executeBranchVerify(deps, store);
        expect(result.status).toBe("success");
        expect(result.details.branch).toBe("chore/270-my-branch");
    });

    test("feature_branch + doesn't match current — throws CurrentIssueError with expected/actual branch", async () => {
        const { deps } = makeMockDeps(async (command) => {
            if (command[0] === RESOLVE_BIN) {
                return makeShellResult({ stdout: makeResolveResponse("feature_branch", "chore/270-my-branch") });
            }
            if (command[0] === "git" && command[1] === "branch") {
                return makeShellResult({ stdout: "some-other-branch\n" });
            }
            return makeShellResult();
        });
        const store = makeMockStore();
        const err = await executeBranchVerify(deps, store).catch((e) => e);
        expect(err).toBeInstanceOf(ScriptStructuredError);
        expect(err.message).toContain("chore/270-my-branch");
        expect(err.message).toContain("some-other-branch");
    });

    test("resolve-issue-branch returns ambiguous — throws CurrentIssueError", async () => {
        const { deps } = makeMockDeps(async (command) => {
            if (command[0] === RESOLVE_BIN) {
                return makeShellResult({ stdout: makeResolveResponse("ambiguous", "", "", "two branches"), exitCode: 0 });
            }
            return makeShellResult();
        });
        const store = makeMockStore();
        const err = await executeBranchVerify(deps, store).catch((e) => e);
        expect(err).toBeInstanceOf(ScriptStructuredError);
        expect(err.message).toContain("ambiguous");
    });
});
