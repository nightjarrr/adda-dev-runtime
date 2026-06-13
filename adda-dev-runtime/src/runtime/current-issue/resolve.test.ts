import { describe, expect, mock, test } from "bun:test";
import type { Shell, ShellDep, ShellResult } from "../../lib/index";
import { ScriptStructuredError } from "../../lib/index";
import { resolveIssueBranch } from "./resolve";

// --- Helpers ---

function makeShellResult(overrides: Partial<ShellResult> = {}): ShellResult {
    return { stdout: "", stderr: "", exitCode: 0, ...overrides };
}

function makeOkResponse(resolution: string, branch = "", pr = "", issue_id = "42"): string {
    return JSON.stringify({ status: "ok", result: { issue_id, resolution, branch, pr }, error: null });
}

function makeFailResponse(reason: string, message: string, details: Record<string, unknown> = {}): string {
    return JSON.stringify({ status: "fail", result: null, error: { reason, message, details } });
}

// --- Mock factory ---

function makeMockDeps(shellRun?: (command: string[]) => Promise<ShellResult>): {
    deps: ShellDep;
} {
    const defaultShellRun = async (): Promise<ShellResult> =>
        makeShellResult({ stdout: makeOkResponse("feature_branch", "feature/1-my-branch", "42") });

    const mockShell: Shell = {
        run: mock(shellRun ?? defaultShellRun),
        runSh: mock(async (_cmd: string) => makeShellResult()),
    };

    const deps: ShellDep = {
        shell: mockShell,
    };

    return { deps };
}

// --- Tests ---

describe("resolveIssueBranch", () => {
    test("non-zero exit carries verboseStderr and throws CurrentIssueError", async () => {
        const { deps } = makeMockDeps(async () => makeShellResult({ stdout: "", stderr: "some error", exitCode: 1 }));
        const err = await resolveIssueBranch(deps, "42").catch((e) => e);
        expect(err).toBeInstanceOf(ScriptStructuredError);
        expect(err.verboseStderr).toContain("some error");
    });

    test("invalid JSON throws CurrentIssueError with 'invalid JSON'", async () => {
        const { deps } = makeMockDeps(async () => makeShellResult({ stdout: "not valid json{{", exitCode: 0 }));
        await expect(resolveIssueBranch(deps, "42")).rejects.toMatchObject({
            message: expect.stringContaining("invalid JSON"),
        });
    });

    test("schema validation failure throws CurrentIssueError with short message in envelope", async () => {
        const { deps } = makeMockDeps(async () =>
            makeShellResult({
                stdout: JSON.stringify({ status: "ok", result: { resolution: "feature_branch" } }),
                exitCode: 0,
            }),
        );
        const err = await resolveIssueBranch(deps, "42").catch((e) => e);
        expect(err).toBeInstanceOf(ScriptStructuredError);
        const envelope = (err as ScriptStructuredError).envelope as Record<string, unknown>;
        expect(String(envelope.error)).toContain("unexpected resolve-issue-branch output");
    });

    test("fail status with reason ambiguous carries verboseStderr and throws CurrentIssueError", async () => {
        const { deps } = makeMockDeps(async () =>
            makeShellResult({
                stdout: makeFailResponse("ambiguous", "multiple linked branches: a, b", { branches: ["a", "b"] }),
                stderr: "ambiguous detail",
                exitCode: 0,
            }),
        );
        const err = await resolveIssueBranch(deps, "42").catch((e) => e);
        expect(err).toBeInstanceOf(ScriptStructuredError);
        expect(err.verboseStderr).toContain("ambiguous detail");
    });

    test("fail status with reason api_error carries verboseStderr and throws CurrentIssueError", async () => {
        const { deps } = makeMockDeps(async () =>
            makeShellResult({
                stdout: makeFailResponse("api_error", "GraphQL API call failed"),
                stderr: "error detail",
                exitCode: 0,
            }),
        );
        const err = await resolveIssueBranch(deps, "42").catch((e) => e);
        expect(err).toBeInstanceOf(ScriptStructuredError);
        expect(err.verboseStderr).toContain("error detail");
    });

    test("ok status with resolution main returns data successfully", async () => {
        const { deps } = makeMockDeps(async () => makeShellResult({ stdout: makeOkResponse("main", "", ""), exitCode: 0 }));
        const data = await resolveIssueBranch(deps, "42");
        expect(data.resolution).toBe("main");
        expect(data.branch).toBe("");
        expect(data.pr).toBe("");
    });

    test("ok status with resolution feature_branch returns data with branch and pr", async () => {
        const { deps } = makeMockDeps(async () =>
            makeShellResult({ stdout: makeOkResponse("feature_branch", "feature/42-my-branch", "99"), exitCode: 0 }),
        );
        const data = await resolveIssueBranch(deps, "42");
        expect(data.resolution).toBe("feature_branch");
        expect(data.branch).toBe("feature/42-my-branch");
        expect(data.pr).toBe("99");
    });
});
