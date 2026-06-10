import { describe, expect, mock, test } from "bun:test";
import type { Shell, ShellDep, ShellResult, StdioDep } from "../../lib/index";
import { ScriptZodValidationError } from "../../lib/index";
import type { ScriptOutput } from "./types";
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
    deps: ShellDep;
    output: ScriptOutput & { emitted: unknown[]; forwarded: string[]; failed: string[] };
} {
    const defaultShellRun = async (): Promise<ShellResult> =>
        makeShellResult({ stdout: makeResolveResponse("feature_branch", "feature/1-my-branch", "42") });

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

// --- Tests ---

describe("resolveIssueBranch", () => {
    test("non-zero exit forwards stderr and calls fail", async () => {
        const { deps, output } = makeMockDeps(async () => makeShellResult({ stdout: "", stderr: "some error", exitCode: 1 }));
        await expect(resolveIssueBranch(deps, "42", output)).rejects.toThrow();
        expect(output.forwarded).toContain("some error");
        expect(output.failed.length).toBe(1);
        expect(output.failed[0]).toContain("42");
    });

    test("invalid JSON calls fail", async () => {
        const { deps, output } = makeMockDeps(async () => makeShellResult({ stdout: "not valid json{{", exitCode: 0 }));
        await expect(resolveIssueBranch(deps, "42", output)).rejects.toThrow();
        expect(output.failed.length).toBe(1);
        expect(output.failed[0]).toContain("invalid JSON");
    });

    test("schema validation failure emits error and throws ScriptZodValidationError", async () => {
        const { deps, output } = makeMockDeps(async () =>
            makeShellResult({ stdout: JSON.stringify({ status: "feature_branch" }), exitCode: 0 }),
        );
        await expect(resolveIssueBranch(deps, "42", output)).rejects.toBeInstanceOf(ScriptZodValidationError);
        expect(output.emitted.length).toBe(1);
    });

    test("ambiguous status forwards stderr and calls fail", async () => {
        const { deps, output } = makeMockDeps(async () =>
            makeShellResult({
                stdout: makeResolveResponse("ambiguous", "", "", "multiple branches"),
                stderr: "ambiguous detail",
                exitCode: 0,
            }),
        );
        await expect(resolveIssueBranch(deps, "42", output)).rejects.toThrow();
        expect(output.forwarded).toContain("ambiguous detail");
        expect(output.failed.length).toBe(1);
        expect(output.failed[0]).toContain("ambiguous");
    });

    test("error status forwards stderr and calls fail", async () => {
        const { deps, output } = makeMockDeps(async () =>
            makeShellResult({
                stdout: makeResolveResponse("error", "", "", "something failed"),
                stderr: "error detail",
                exitCode: 0,
            }),
        );
        await expect(resolveIssueBranch(deps, "42", output)).rejects.toThrow();
        expect(output.forwarded).toContain("error detail");
        expect(output.failed.length).toBe(1);
        expect(output.failed[0]).toContain("error");
    });

    test("main status returns data successfully", async () => {
        const { deps, output } = makeMockDeps(async () =>
            makeShellResult({ stdout: makeResolveResponse("main", "", "", ""), exitCode: 0 }),
        );
        const data = await resolveIssueBranch(deps, "42", output);
        expect(data.status).toBe("main");
        expect(data.branch).toBe("");
        expect(data.pr).toBe("");
        expect(output.failed.length).toBe(0);
    });

    test("feature_branch status returns data with branch and pr", async () => {
        const { deps, output } = makeMockDeps(async () =>
            makeShellResult({ stdout: makeResolveResponse("feature_branch", "feature/42-my-branch", "99"), exitCode: 0 }),
        );
        const data = await resolveIssueBranch(deps, "42", output);
        expect(data.status).toBe("feature_branch");
        expect(data.branch).toBe("feature/42-my-branch");
        expect(data.pr).toBe("99");
        expect(output.failed.length).toBe(0);
    });
});
