import { describe, expect, mock, test } from "bun:test";
import type { Shell, ShellDep, ShellResult, StdioDep } from "../../lib/index";
import { ScriptStructuredError } from "../../lib/index";
import { resolveIssueBranch } from "./resolve";

// --- Helpers ---

function makeShellResult(overrides: Partial<ShellResult> = {}): ShellResult {
    return { stdout: "", stderr: "", exitCode: 0, ...overrides };
}

function makeResolveResponse(status: string, branch = "", pr = "", details = ""): string {
    return JSON.stringify({ status, branch, pr, details });
}

// --- Mock factory ---

function makeMockDeps(shellRun?: (command: string[]) => Promise<ShellResult>): {
    deps: ShellDep & StdioDep;
    errLines: string[];
} {
    const defaultShellRun = async (): Promise<ShellResult> =>
        makeShellResult({ stdout: makeResolveResponse("feature_branch", "feature/1-my-branch", "42") });

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

// --- Tests ---

describe("resolveIssueBranch", () => {
    test("non-zero exit forwards stderr and throws CurrentIssueError", async () => {
        const { deps, errLines } = makeMockDeps(async () => makeShellResult({ stdout: "", stderr: "some error", exitCode: 1 }));
        await expect(resolveIssueBranch(deps, "42")).rejects.toBeInstanceOf(ScriptStructuredError);
        expect(errLines.join("")).toContain("some error");
    });

    test("invalid JSON throws CurrentIssueError with 'invalid JSON'", async () => {
        const { deps } = makeMockDeps(async () => makeShellResult({ stdout: "not valid json{{", exitCode: 0 }));
        await expect(resolveIssueBranch(deps, "42")).rejects.toMatchObject({
            message: expect.stringContaining("invalid JSON"),
        });
    });

    test("schema validation failure throws CurrentIssueError with short message in envelope, full message as diagnostic", async () => {
        const { deps } = makeMockDeps(async () =>
            makeShellResult({ stdout: JSON.stringify({ status: "feature_branch" }), exitCode: 0 }),
        );
        const err = await resolveIssueBranch(deps, "42").catch((e) => e);
        expect(err).toBeInstanceOf(ScriptStructuredError);
        const envelope = (err as ScriptStructuredError).envelope as Record<string, unknown>;
        expect(String(envelope.error)).toContain("unexpected resolve-issue-branch output");
    });

    test("ambiguous status forwards stderr and throws CurrentIssueError", async () => {
        const { deps, errLines } = makeMockDeps(async () =>
            makeShellResult({
                stdout: makeResolveResponse("ambiguous", "", "", "multiple branches"),
                stderr: "ambiguous detail",
                exitCode: 0,
            }),
        );
        await expect(resolveIssueBranch(deps, "42")).rejects.toBeInstanceOf(ScriptStructuredError);
        expect(errLines.join("")).toContain("ambiguous detail");
    });

    test("error status forwards stderr and throws CurrentIssueError", async () => {
        const { deps, errLines } = makeMockDeps(async () =>
            makeShellResult({
                stdout: makeResolveResponse("error", "", "", "something failed"),
                stderr: "error detail",
                exitCode: 0,
            }),
        );
        await expect(resolveIssueBranch(deps, "42")).rejects.toBeInstanceOf(ScriptStructuredError);
        expect(errLines.join("")).toContain("error detail");
    });

    test("main status returns data successfully", async () => {
        const { deps } = makeMockDeps(async () =>
            makeShellResult({ stdout: makeResolveResponse("main", "", "", ""), exitCode: 0 }),
        );
        const data = await resolveIssueBranch(deps, "42");
        expect(data.status).toBe("main");
        expect(data.branch).toBe("");
        expect(data.pr).toBe("");
    });

    test("feature_branch status returns data with branch and pr", async () => {
        const { deps } = makeMockDeps(async () =>
            makeShellResult({ stdout: makeResolveResponse("feature_branch", "feature/42-my-branch", "99"), exitCode: 0 }),
        );
        const data = await resolveIssueBranch(deps, "42");
        expect(data.status).toBe("feature_branch");
        expect(data.branch).toBe("feature/42-my-branch");
        expect(data.pr).toBe("99");
    });
});
