import { describe, expect, mock, test } from "bun:test";
import type { Shell, ShellDep, ShellResult } from "../../lib/index";
import type { IssueState, IssueStateStore, ScriptOutput } from "./types";
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
    deps: ShellDep;
    output: ScriptOutput & { emitted: unknown[]; forwarded: string[]; failed: string[] };
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

    const deps: ShellDep = { shell: mockShell };

    const emitted: unknown[] = [];
    const forwarded: string[] = [];
    const failed: string[] = [];

    const output: ScriptOutput & { emitted: unknown[]; forwarded: string[]; failed: string[] } = {
        emitted,
        forwarded,
        failed,
        emit(envelope) {
            emitted.push(envelope);
        },
        forwardStderr(result) {
            if (result.stderr) forwarded.push(result.stderr);
        },
        fail(message): never {
            failed.push(message);
            throw new Error(message);
        },
    };

    return { deps, output };
}

// --- executeBranchEnsure tests ---

describe("executeBranchEnsure", () => {
    test("no stored issue — calls fail with 'no current issue set'", async () => {
        const { deps, output } = makeMockDeps();
        const store = makeMockStore(null);
        await expect(executeBranchEnsure(deps, store, output)).rejects.toThrow();
        expect(output.failed.length).toBe(1);
        expect(output.failed[0]).toContain("no current issue set");
    });

    test("resolve-issue-branch exits non-zero — calls fail", async () => {
        const { deps, output } = makeMockDeps(async (command) => {
            if (command[0] === RESOLVE_BIN) {
                return makeShellResult({ stdout: "", stderr: "some error", exitCode: 1 });
            }
            return makeShellResult();
        });
        const store = makeMockStore();
        await expect(executeBranchEnsure(deps, store, output)).rejects.toThrow();
        expect(output.failed.length).toBe(1);
    });

    test("resolve-issue-branch returns invalid JSON — calls fail", async () => {
        const { deps, output } = makeMockDeps(async (command) => {
            if (command[0] === RESOLVE_BIN) {
                return makeShellResult({ stdout: "not valid json{{", exitCode: 0 });
            }
            return makeShellResult();
        });
        const store = makeMockStore();
        await expect(executeBranchEnsure(deps, store, output)).rejects.toThrow();
        expect(output.failed.length).toBe(1);
    });

    test("resolve-issue-branch returns ambiguous — calls fail", async () => {
        const { deps, output } = makeMockDeps(async (command) => {
            if (command[0] === RESOLVE_BIN) {
                return makeShellResult({ stdout: makeResolveResponse("ambiguous", "", "", "two branches"), exitCode: 0 });
            }
            return makeShellResult();
        });
        const store = makeMockStore();
        await expect(executeBranchEnsure(deps, store, output)).rejects.toThrow();
        expect(output.failed.length).toBe(1);
        expect(output.failed[0]).toContain("ambiguous");
    });

    test("feature_branch + current matches — emits success with action: none", async () => {
        const { deps, output } = makeMockDeps(async (command) => {
            if (command[0] === RESOLVE_BIN) {
                return makeShellResult({ stdout: makeResolveResponse("feature_branch", "chore/270-my-branch") });
            }
            if (command[0] === "git" && command[1] === "branch") {
                return makeShellResult({ stdout: "chore/270-my-branch\n" });
            }
            return makeShellResult();
        });
        const store = makeMockStore();
        await executeBranchEnsure(deps, store, output);
        expect(output.emitted.length).toBe(1);
        const env = output.emitted[0] as { status: string; details: { action: string; branch: string } };
        expect(env.status).toBe("success");
        expect(env.details.action).toBe("none");
        expect(env.details.branch).toBe("chore/270-my-branch");
    });

    test("feature_branch + current doesn't match — calls fail with expected branch info", async () => {
        const { deps, output } = makeMockDeps(async (command) => {
            if (command[0] === RESOLVE_BIN) {
                return makeShellResult({ stdout: makeResolveResponse("feature_branch", "chore/270-my-branch") });
            }
            if (command[0] === "git" && command[1] === "branch") {
                return makeShellResult({ stdout: "some-other-branch\n" });
            }
            return makeShellResult();
        });
        const store = makeMockStore();
        await expect(executeBranchEnsure(deps, store, output)).rejects.toThrow();
        expect(output.failed.length).toBe(1);
        expect(output.failed[0]).toContain("chore/270-my-branch");
        expect(output.failed[0]).toContain("some-other-branch");
    });

    test("main + current is not main — calls fail with expected/actual branch info", async () => {
        const { deps, output } = makeMockDeps(async (command) => {
            if (command[0] === RESOLVE_BIN) {
                return makeShellResult({ stdout: makeResolveResponse("main") });
            }
            if (command[0] === "git" && command[1] === "branch") {
                return makeShellResult({ stdout: "some-other-branch\n" });
            }
            return makeShellResult();
        });
        const store = makeMockStore();
        await expect(executeBranchEnsure(deps, store, output)).rejects.toThrow();
        expect(output.failed.length).toBe(1);
        expect(output.failed[0]).toContain("some-other-branch");
    });

    test("main + current is main, normal title — emits success with action: created, correct branch name", async () => {
        const ghDevelopCalls: string[][] = [];
        const { deps, output } = makeMockDeps(async (command) => {
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
        await executeBranchEnsure(deps, store, output);
        expect(output.emitted.length).toBe(1);
        const env = output.emitted[0] as { status: string; details: { action: string; branch: string } };
        expect(env.status).toBe("success");
        expect(env.details.action).toBe("created");
        expect(env.details.branch).toBe("chore/270-branch-lifecycle-tooling-for-sdlc-roles");
        expect(ghDevelopCalls.length).toBe(1);
        expect(ghDevelopCalls[0]).toContain("chore/270-branch-lifecycle-tooling-for-sdlc-roles");
        expect(ghDevelopCalls[0]).toContain("270");
        expect(ghDevelopCalls[0]).toContain("--checkout");
    });

    test("main + current is main, degenerate title (all Unicode) — emits success with action: created, warning present", async () => {
        const { deps, output } = makeMockDeps(async (command) => {
            if (command[0] === RESOLVE_BIN) {
                return makeShellResult({ stdout: makeResolveResponse("main") });
            }
            if (command[0] === "git" && command[1] === "branch") {
                return makeShellResult({ stdout: "main\n" });
            }
            return makeShellResult();
        });
        const store = makeMockStore({ ...DEFAULT_STATE, title: "😀🎉✨" });
        await executeBranchEnsure(deps, store, output);
        expect(output.emitted.length).toBe(1);
        const env = output.emitted[0] as { status: string; details: { action: string; branch: string; warning?: string } };
        expect(env.status).toBe("success");
        expect(env.details.action).toBe("created");
        expect(typeof env.details.warning).toBe("string");
        expect(env.details.branch).toMatch(/^chore\/270-[a-z0-9]{8}$/);
    });

    test("gh issue develop fails — forwards stderr and calls fail", async () => {
        const { deps, output } = makeMockDeps(async (command) => {
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
        await expect(executeBranchEnsure(deps, store, output)).rejects.toThrow();
        expect(output.forwarded).toContain("gh error output");
        expect(output.failed.length).toBe(1);
    });

    test("git branch --show-current fails — forwards stderr and calls fail", async () => {
        const { deps, output } = makeMockDeps(async (command) => {
            if (command[0] === RESOLVE_BIN) {
                return makeShellResult({ stdout: makeResolveResponse("feature_branch", "chore/270-my-branch") });
            }
            if (command[0] === "git" && command[1] === "branch") {
                return makeShellResult({ stdout: "", stderr: "fatal: not a git repository", exitCode: 1 });
            }
            return makeShellResult();
        });
        const store = makeMockStore();
        await expect(executeBranchEnsure(deps, store, output)).rejects.toThrow();
        expect(output.forwarded).toContain("fatal: not a git repository");
        expect(output.failed.length).toBe(1);
        expect(output.failed[0]).toContain("git branch --show-current failed");
    });
});

// --- executeBranchVerify tests ---

describe("executeBranchVerify", () => {
    test("no stored issue — calls fail with 'no current issue set'", async () => {
        const { deps, output } = makeMockDeps();
        const store = makeMockStore(null);
        await expect(executeBranchVerify(deps, store, output)).rejects.toThrow();
        expect(output.failed.length).toBe(1);
        expect(output.failed[0]).toContain("no current issue set");
    });

    test("resolve-issue-branch exits non-zero — calls fail", async () => {
        const { deps, output } = makeMockDeps(async (command) => {
            if (command[0] === RESOLVE_BIN) {
                return makeShellResult({ stdout: "", stderr: "some error", exitCode: 1 });
            }
            return makeShellResult();
        });
        const store = makeMockStore();
        await expect(executeBranchVerify(deps, store, output)).rejects.toThrow();
        expect(output.failed.length).toBe(1);
    });

    test("resolve-issue-branch returns main — calls fail with 'no feature branch linked'", async () => {
        const { deps, output } = makeMockDeps(async (command) => {
            if (command[0] === RESOLVE_BIN) {
                return makeShellResult({ stdout: makeResolveResponse("main") });
            }
            return makeShellResult();
        });
        const store = makeMockStore();
        await expect(executeBranchVerify(deps, store, output)).rejects.toThrow();
        expect(output.failed.length).toBe(1);
        expect(output.failed[0]).toContain("no feature branch linked");
    });

    test("feature_branch + matches current — emits success with branch", async () => {
        const { deps, output } = makeMockDeps(async (command) => {
            if (command[0] === RESOLVE_BIN) {
                return makeShellResult({ stdout: makeResolveResponse("feature_branch", "chore/270-my-branch") });
            }
            if (command[0] === "git" && command[1] === "branch") {
                return makeShellResult({ stdout: "chore/270-my-branch\n" });
            }
            return makeShellResult();
        });
        const store = makeMockStore();
        await executeBranchVerify(deps, store, output);
        expect(output.emitted.length).toBe(1);
        const env = output.emitted[0] as { status: string; details: { branch: string } };
        expect(env.status).toBe("success");
        expect(env.details.branch).toBe("chore/270-my-branch");
    });

    test("feature_branch + doesn't match current — calls fail with expected/actual branch", async () => {
        const { deps, output } = makeMockDeps(async (command) => {
            if (command[0] === RESOLVE_BIN) {
                return makeShellResult({ stdout: makeResolveResponse("feature_branch", "chore/270-my-branch") });
            }
            if (command[0] === "git" && command[1] === "branch") {
                return makeShellResult({ stdout: "some-other-branch\n" });
            }
            return makeShellResult();
        });
        const store = makeMockStore();
        await expect(executeBranchVerify(deps, store, output)).rejects.toThrow();
        expect(output.failed.length).toBe(1);
        expect(output.failed[0]).toContain("chore/270-my-branch");
        expect(output.failed[0]).toContain("some-other-branch");
    });

    test("resolve-issue-branch returns ambiguous — calls fail", async () => {
        const { deps, output } = makeMockDeps(async (command) => {
            if (command[0] === RESOLVE_BIN) {
                return makeShellResult({ stdout: makeResolveResponse("ambiguous", "", "", "two branches"), exitCode: 0 });
            }
            return makeShellResult();
        });
        const store = makeMockStore();
        await expect(executeBranchVerify(deps, store, output)).rejects.toThrow();
        expect(output.failed.length).toBe(1);
        expect(output.failed[0]).toContain("ambiguous");
    });
});
