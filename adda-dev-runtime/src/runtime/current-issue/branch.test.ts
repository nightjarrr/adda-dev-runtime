import { describe, expect, mock, test } from "bun:test";
import type { Shell, ShellDep, ShellResult } from "../../lib/index";
import { ScriptError, ScriptShellError } from "../../lib/index";
import type { IssueState, IssueStateStore } from "./types";
import { executeBranchEnsure, executeBranchVerify } from "./branch";

// --- Helpers ---

function makeShellResult(overrides: Partial<ShellResult> = {}): ShellResult {
    return { stdout: "", stderr: "", exitCode: 0, ...overrides };
}

function makeOkResponse(resolution: string, branch = "", pr = "", issue_id = "270"): string {
    return JSON.stringify({ status: "ok", result: { issue_id, resolution, branch, pr }, error: null });
}

function makeFailResponse(reason: string, message: string): string {
    return JSON.stringify({ status: "fail", result: null, error: { reason, message, details: {} } });
}

const RESOLVE_BIN = "/usr/local/libexec/adda-dev-runtime/bin/resolve-issue-branch";

const DEFAULT_STATE: IssueState = {
    id: "270",
    title: "Branch lifecycle tooling for SDLC roles",
    type: "chore",
    phase: "",
    state: "OPEN",
    pr: "",
    parent: null,
    children: [],
    siblings: [],
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
} {
    const defaultShellRun = async (command: string[]): Promise<ShellResult> => {
        if (command[0] === RESOLVE_BIN) {
            return makeShellResult({
                stdout: makeOkResponse("feature_branch", "chore/270-branch-lifecycle-tooling-for-sdlc-roles"),
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

    const deps: ShellDep = {
        shell: mockShell,
    };

    return { deps };
}

// --- executeBranchEnsure tests ---

describe("executeBranchEnsure", () => {
    test("no stored issue — throws ScriptError with 'no current issue set'", async () => {
        const { deps } = makeMockDeps();
        const store = makeMockStore(null);
        const err = await executeBranchEnsure(deps, store).catch((e) => e);
        expect(err).toBeInstanceOf(ScriptError);
        expect(err.message).toContain("no current issue set");
    });

    test("resolve-issue-branch exits non-zero — throws ScriptError", async () => {
        const { deps } = makeMockDeps(async (command) => {
            if (command[0] === RESOLVE_BIN) {
                throw new ScriptShellError(RESOLVE_BIN, 1, "", "some error");
            }
            return makeShellResult();
        });
        const store = makeMockStore();
        await expect(executeBranchEnsure(deps, store)).rejects.toBeInstanceOf(ScriptError);
    });

    test("resolve-issue-branch returns invalid JSON — throws ScriptError", async () => {
        const { deps } = makeMockDeps(async (command) => {
            if (command[0] === RESOLVE_BIN) {
                return makeShellResult({ stdout: "not valid json{{", exitCode: 0 });
            }
            return makeShellResult();
        });
        const store = makeMockStore();
        await expect(executeBranchEnsure(deps, store)).rejects.toBeInstanceOf(ScriptError);
    });

    test("resolve-issue-branch returns fail with reason ambiguous — throws ScriptError with 'ambiguous'", async () => {
        const { deps } = makeMockDeps(async (command) => {
            if (command[0] === RESOLVE_BIN) {
                return makeShellResult({
                    stdout: makeFailResponse("ambiguous_result", "multiple linked branches: a, b"),
                    exitCode: 0,
                });
            }
            return makeShellResult();
        });
        const store = makeMockStore();
        const err = await executeBranchEnsure(deps, store).catch((e) => e);
        expect(err).toBeInstanceOf(ScriptError);
        const envelope = (err as ScriptError).envelope;
        expect(envelope.status).toBe("fail");
        expect(envelope.error?.reason).toBe("ambiguous_result");
    });

    test("feature_branch + current matches — returns result with action: none", async () => {
        const { deps } = makeMockDeps(async (command) => {
            if (command[0] === RESOLVE_BIN) {
                return makeShellResult({ stdout: makeOkResponse("feature_branch", "chore/270-my-branch") });
            }
            if (command[0] === "git" && command[1] === "branch") {
                return makeShellResult({ stdout: "chore/270-my-branch\n" });
            }
            return makeShellResult();
        });
        const store = makeMockStore();
        const result = await executeBranchEnsure(deps, store);
        expect(result.details.action).toBe("none");
        expect(result.details.branch).toBe("chore/270-my-branch");
    });

    test("feature_branch + current doesn't match — throws ScriptError with expected branch info", async () => {
        const { deps } = makeMockDeps(async (command) => {
            if (command[0] === RESOLVE_BIN) {
                return makeShellResult({ stdout: makeOkResponse("feature_branch", "chore/270-my-branch") });
            }
            if (command[0] === "git" && command[1] === "branch") {
                return makeShellResult({ stdout: "some-other-branch\n" });
            }
            return makeShellResult();
        });
        const store = makeMockStore();
        const err = await executeBranchEnsure(deps, store).catch((e) => e);
        expect(err).toBeInstanceOf(ScriptError);
        expect(err.message).toContain("chore/270-my-branch");
        expect(err.message).toContain("some-other-branch");
    });

    test("main + current is not main — throws ScriptError with expected/actual branch info", async () => {
        const { deps } = makeMockDeps(async (command) => {
            if (command[0] === RESOLVE_BIN) {
                return makeShellResult({ stdout: makeOkResponse("main") });
            }
            if (command[0] === "git" && command[1] === "branch") {
                return makeShellResult({ stdout: "some-other-branch\n" });
            }
            return makeShellResult();
        });
        const store = makeMockStore();
        const err = await executeBranchEnsure(deps, store).catch((e) => e);
        expect(err).toBeInstanceOf(ScriptError);
        expect(err.message).toContain("some-other-branch");
    });

    test("main + current is main, normal title — returns result with action: created, correct branch name", async () => {
        const ghDevelopCalls: string[][] = [];
        const { deps } = makeMockDeps(async (command) => {
            if (command[0] === RESOLVE_BIN) {
                return makeShellResult({ stdout: makeOkResponse("main") });
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
        expect(result.details.action).toBe("created");
        expect(result.details.branch).toBe("chore/270-branch-lifecycle-tooling-for-sdlc-roles");
        expect(ghDevelopCalls.length).toBe(1);
        expect(ghDevelopCalls[0]).toContain("chore/270-branch-lifecycle-tooling-for-sdlc-roles");
        expect(ghDevelopCalls[0]).toContain("270");
        expect(ghDevelopCalls[0]).toContain("--checkout");
    });

    test("main + current is main, degenerate title (all Unicode) — returns result with action: created, warning present", async () => {
        const { deps } = makeMockDeps(async (command) => {
            if (command[0] === RESOLVE_BIN) {
                return makeShellResult({ stdout: makeOkResponse("main") });
            }
            if (command[0] === "git" && command[1] === "branch") {
                return makeShellResult({ stdout: "main\n" });
            }
            return makeShellResult();
        });
        const store = makeMockStore({ ...DEFAULT_STATE, title: "😀🎉✨" });
        const result = await executeBranchEnsure(deps, store);
        expect(result.details.action).toBe("created");
        expect(typeof result.details.warning).toBe("string");
        expect(String(result.details.branch)).toMatch(/^chore\/270-[a-z0-9]{8}$/);
    });

    test("gh issue develop fails — error carries verboseStderr and throws ScriptError", async () => {
        const { deps } = makeMockDeps(async (command) => {
            if (command[0] === RESOLVE_BIN) {
                return makeShellResult({ stdout: makeOkResponse("main") });
            }
            if (command[0] === "git" && command[1] === "branch") {
                return makeShellResult({ stdout: "main\n" });
            }
            if (command[0] === "gh") {
                throw new ScriptShellError(command.join(" "), 1, "", "gh error output");
            }
            return makeShellResult();
        });
        const store = makeMockStore();
        const err = await executeBranchEnsure(deps, store).catch((e) => e);
        expect(err).toBeInstanceOf(ScriptError);
        expect(err.verboseStderr).toContain("gh error output");
    });

    test("git branch --show-current fails — error carries verboseStderr and throws ScriptError", async () => {
        const { deps } = makeMockDeps(async (command) => {
            if (command[0] === RESOLVE_BIN) {
                return makeShellResult({ stdout: makeOkResponse("feature_branch", "chore/270-my-branch") });
            }
            if (command[0] === "git" && command[1] === "branch") {
                throw new ScriptShellError("git branch --show-current", 128, "", "fatal: not a git repository");
            }
            return makeShellResult();
        });
        const store = makeMockStore();
        const err = await executeBranchEnsure(deps, store).catch((e) => e);
        expect(err).toBeInstanceOf(ScriptError);
        expect(err.verboseStderr).toContain("fatal: not a git repository");
        expect((err as ScriptError).envelope.error?.details?.cmd).toContain("git branch --show-current");
    });
});

// --- executeBranchVerify tests ---

describe("executeBranchVerify", () => {
    test("no stored issue — throws ScriptError with 'no current issue set'", async () => {
        const { deps } = makeMockDeps();
        const store = makeMockStore(null);
        const err = await executeBranchVerify(deps, store).catch((e) => e);
        expect(err).toBeInstanceOf(ScriptError);
        expect(err.message).toContain("no current issue set");
    });

    test("resolve-issue-branch exits non-zero — throws ScriptError", async () => {
        const { deps } = makeMockDeps(async (command) => {
            if (command[0] === RESOLVE_BIN) {
                throw new ScriptShellError(RESOLVE_BIN, 1, "", "some error");
            }
            return makeShellResult();
        });
        const store = makeMockStore();
        await expect(executeBranchVerify(deps, store)).rejects.toBeInstanceOf(ScriptError);
    });

    test("resolve-issue-branch returns ok with resolution main — throws ScriptError with 'no feature branch linked'", async () => {
        const { deps } = makeMockDeps(async (command) => {
            if (command[0] === RESOLVE_BIN) {
                return makeShellResult({ stdout: makeOkResponse("main") });
            }
            return makeShellResult();
        });
        const store = makeMockStore();
        const err = await executeBranchVerify(deps, store).catch((e) => e);
        expect(err).toBeInstanceOf(ScriptError);
        expect(err.message).toContain("no feature branch linked");
    });

    test("feature_branch + matches current — returns result with branch", async () => {
        const { deps } = makeMockDeps(async (command) => {
            if (command[0] === RESOLVE_BIN) {
                return makeShellResult({ stdout: makeOkResponse("feature_branch", "chore/270-my-branch") });
            }
            if (command[0] === "git" && command[1] === "branch") {
                return makeShellResult({ stdout: "chore/270-my-branch\n" });
            }
            return makeShellResult();
        });
        const store = makeMockStore();
        const result = await executeBranchVerify(deps, store);
        expect(result.details.branch).toBe("chore/270-my-branch");
    });

    test("feature_branch + doesn't match current — throws ScriptError with expected/actual branch", async () => {
        const { deps } = makeMockDeps(async (command) => {
            if (command[0] === RESOLVE_BIN) {
                return makeShellResult({ stdout: makeOkResponse("feature_branch", "chore/270-my-branch") });
            }
            if (command[0] === "git" && command[1] === "branch") {
                return makeShellResult({ stdout: "some-other-branch\n" });
            }
            return makeShellResult();
        });
        const store = makeMockStore();
        const err = await executeBranchVerify(deps, store).catch((e) => e);
        expect(err).toBeInstanceOf(ScriptError);
        expect(err.message).toContain("chore/270-my-branch");
        expect(err.message).toContain("some-other-branch");
    });

    test("resolve-issue-branch returns fail with reason ambiguous — throws ScriptError", async () => {
        const { deps } = makeMockDeps(async (command) => {
            if (command[0] === RESOLVE_BIN) {
                return makeShellResult({
                    stdout: makeFailResponse("ambiguous_result", "multiple linked branches: a, b"),
                    exitCode: 0,
                });
            }
            return makeShellResult();
        });
        const store = makeMockStore();
        const err = await executeBranchVerify(deps, store).catch((e) => e);
        expect(err).toBeInstanceOf(ScriptError);
        const envelope = (err as ScriptError).envelope;
        expect(envelope.status).toBe("fail");
        expect(envelope.error?.reason).toBe("ambiguous_result");
    });
});
