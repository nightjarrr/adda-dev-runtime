import { describe, expect, mock, test } from "bun:test";
import type { Env, EnvDep, Shell, ShellDep, ShellResult, StdioDep } from "../lib/index";
import { ScriptShellError } from "../lib/index";
import { IssueHierarchyScript } from "./issue-hierarchy";
import { fetchChildren } from "./issue-hierarchy/fetch";

type IssueHierarchyDeps = ShellDep & EnvDep & StdioDep;

// --- Mock helpers ---

function makeShellResult(stdout: string, exitCode = 0, stderr = ""): ShellResult {
    return { stdout, stderr, exitCode };
}

interface MockDepsOptions {
    runQueue?: ShellResult[];
    envVars?: Record<string, string>;
}

interface MockDepsResult {
    deps: IssueHierarchyDeps;
    outLines: string[];
    errLines: string[];
    runCalls: string[][];
}

function makeMockDeps(options: MockDepsOptions = {}): MockDepsResult {
    const outLines: string[] = [];
    const errLines: string[] = [];
    const runCalls: string[][] = [];

    const runQueue = options.runQueue ? [...options.runQueue] : [];

    const mockShell: Shell = {
        run: mock(async (command: string[], opts?: { strict?: boolean }) => {
            runCalls.push(command);
            const result = runQueue.shift() ?? makeShellResult("");
            if ((opts?.strict ?? true) && result.exitCode !== 0) {
                throw new ScriptShellError(command.join(" "), result.exitCode, result.stdout, result.stderr);
            }
            return result;
        }),
        runSh: mock(async () => makeShellResult("")),
    };

    const envVars = options.envVars ?? {
        GITHUB_OWNER: "testowner",
        GITHUB_REPO: "testrepo",
    };

    const mockEnv: Env = {
        get: mock((name: string) => envVars[name]),
    };

    const deps: IssueHierarchyDeps = {
        shell: mockShell,
        env: mockEnv,
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

    return { deps, outLines, errLines, runCalls };
}

function getStdoutJson(outLines: string[]): unknown {
    return JSON.parse(outLines.join("").trim()) as unknown;
}

// --- Raw sub-issue builder ---

function makeRawSubIssue(number: number, title: string, state: "open" | "closed", labels: string[]): string {
    return JSON.stringify({
        number,
        title,
        state,
        labels: labels.map((name) => ({ name })),
    });
}

// --- Tests ---

describe("IssueHierarchyScript", () => {
    // ---------------------------------------------------------------
    // Argument validation
    // ---------------------------------------------------------------
    describe("argument validation", () => {
        test("no args — exits 2, invalid_args reason", async () => {
            const { deps, outLines } = makeMockDeps();
            const code = await new IssueHierarchyScript(deps).run(["bun", "issue-hierarchy.ts"]);
            expect(code).toBe(2);
            const out = getStdoutJson(outLines) as Record<string, unknown>;
            expect(out.status).toBe("fail");
            expect((out.error as Record<string, unknown>)?.reason).toBe("invalid_args");
        });

        test("unknown subcommand — exits 2, invalid_args reason", async () => {
            const { deps, outLines } = makeMockDeps();
            const code = await new IssueHierarchyScript(deps).run(["bun", "issue-hierarchy.ts", "parents"]);
            expect(code).toBe(2);
            const out = getStdoutJson(outLines) as Record<string, unknown>;
            expect(out.status).toBe("fail");
            expect((out.error as Record<string, unknown>)?.reason).toBe("invalid_args");
        });

        test("children without number — exits 2", async () => {
            const { deps, outLines } = makeMockDeps();
            const code = await new IssueHierarchyScript(deps).run(["bun", "issue-hierarchy.ts", "children"]);
            expect(code).toBe(2);
            const out = getStdoutJson(outLines) as Record<string, unknown>;
            expect(out.status).toBe("fail");
            expect((out.error as Record<string, unknown>)?.reason).toBe("invalid_args");
        });

        test("children nan — exits 2", async () => {
            const { deps, outLines } = makeMockDeps();
            const code = await new IssueHierarchyScript(deps).run(["bun", "issue-hierarchy.ts", "children", "abc"]);
            expect(code).toBe(2);
            const out = getStdoutJson(outLines) as Record<string, unknown>;
            expect(out.status).toBe("fail");
            expect((out.error as Record<string, unknown>)?.reason).toBe("invalid_args");
        });

        test("children 0 — exits 2 (non-positive)", async () => {
            const { deps, outLines } = makeMockDeps();
            const code = await new IssueHierarchyScript(deps).run(["bun", "issue-hierarchy.ts", "children", "0"]);
            expect(code).toBe(2);
            const out = getStdoutJson(outLines) as Record<string, unknown>;
            expect(out.status).toBe("fail");
        });

        test("children -1 — exits 2 (negative)", async () => {
            const { deps, outLines } = makeMockDeps();
            const code = await new IssueHierarchyScript(deps).run(["bun", "issue-hierarchy.ts", "children", "-1"]);
            expect(code).toBe(2);
            const out = getStdoutJson(outLines) as Record<string, unknown>;
            expect(out.status).toBe("fail");
        });
    });

    // ---------------------------------------------------------------
    // Integration tests (via script.run)
    // ---------------------------------------------------------------
    describe("integration", () => {
        test("children <n> with no sub-issues — exit 0, ok envelope with empty children array", async () => {
            const { deps, outLines } = makeMockDeps({
                runQueue: [makeShellResult("")],
            });
            const code = await new IssueHierarchyScript(deps).run(["bun", "issue-hierarchy.ts", "children", "42"]);
            expect(code).toBe(0);
            const out = getStdoutJson(outLines) as {
                status: string;
                result: { parent: number; children: unknown[] };
                error: null;
            };
            expect(out.status).toBe("ok");
            expect(out.result.parent).toBe(42);
            expect(out.result.children).toEqual([]);
            expect(out.error).toBeNull();
        });

        test("children <n> with sub-issues — exit 0, ok envelope with mapped children", async () => {
            const lines = [
                makeRawSubIssue(101, "First child", "open", ["feature", "phase: planning"]),
                makeRawSubIssue(102, "Second child", "closed", ["bug"]),
            ].join("\n");
            const { deps, outLines } = makeMockDeps({
                runQueue: [makeShellResult(lines)],
            });
            const code = await new IssueHierarchyScript(deps).run(["bun", "issue-hierarchy.ts", "children", "10"]);
            expect(code).toBe(0);
            const out = getStdoutJson(outLines) as {
                status: string;
                result: {
                    parent: number;
                    children: Array<{
                        number: number;
                        title: string;
                        state: string;
                        type: string | null;
                        phase: string | null;
                        parent: number;
                        labels: string[];
                    }>;
                };
            };
            expect(out.status).toBe("ok");
            expect(out.result.parent).toBe(10);
            expect(out.result.children).toHaveLength(2);
            expect(out.result.children[0]!.number).toBe(101);
            expect(out.result.children[0]!.type).toBe("feature");
            expect(out.result.children[0]!.phase).toBe("phase: planning");
            expect(out.result.children[1]!.number).toBe(102);
            expect(out.result.children[1]!.type).toBe("bug");
            expect(out.result.children[1]!.phase).toBeNull();
        });

        test("shell error from gh api — exit 1, shell_error reason", async () => {
            const { deps, outLines } = makeMockDeps({
                runQueue: [makeShellResult("", 1, "HTTP 404: Not Found")],
            });
            const code = await new IssueHierarchyScript(deps).run(["bun", "issue-hierarchy.ts", "children", "99"]);
            expect(code).toBe(1);
            const out = getStdoutJson(outLines) as Record<string, unknown>;
            expect(out.status).toBe("fail");
            expect((out.error as Record<string, unknown>)?.reason).toBe("shell_error");
        });

        test("missing GITHUB_OWNER — exit 1, missing_env reason", async () => {
            const { deps, outLines } = makeMockDeps({ envVars: { GITHUB_REPO: "repo" } });
            const code = await new IssueHierarchyScript(deps).run(["bun", "issue-hierarchy.ts", "children", "1"]);
            expect(code).toBe(1);
            const out = getStdoutJson(outLines) as Record<string, unknown>;
            expect(out.status).toBe("fail");
            expect((out.error as Record<string, unknown>)?.reason).toBe("missing_env");
            expect((out.error as Record<string, unknown>)?.message as string).toContain("GITHUB_OWNER");
        });

        test("missing GITHUB_REPO — exit 1, missing_env reason", async () => {
            const { deps, outLines } = makeMockDeps({ envVars: { GITHUB_OWNER: "owner" } });
            const code = await new IssueHierarchyScript(deps).run(["bun", "issue-hierarchy.ts", "children", "1"]);
            expect(code).toBe(1);
            const out = getStdoutJson(outLines) as Record<string, unknown>;
            expect(out.status).toBe("fail");
            expect((out.error as Record<string, unknown>)?.reason).toBe("missing_env");
            expect((out.error as Record<string, unknown>)?.message as string).toContain("GITHUB_REPO");
        });
    });
});

// ---------------------------------------------------------------
// fetchChildren unit tests
// ---------------------------------------------------------------

describe("fetchChildren", () => {
    function makeShellDeps(runQueue: ShellResult[]): ShellDep & EnvDep {
        const queue = [...runQueue];
        const mockShell: Shell = {
            run: mock(async (command: string[], opts?: { strict?: boolean }) => {
                const result = queue.shift() ?? makeShellResult("");
                if ((opts?.strict ?? true) && result.exitCode !== 0) {
                    throw new ScriptShellError(command.join(" "), result.exitCode, result.stdout, result.stderr);
                }
                return result;
            }),
            runSh: mock(async () => makeShellResult("")),
        };
        const mockEnv: Env = {
            get: mock((name: string) => ({ GITHUB_OWNER: "o", GITHUB_REPO: "r" })[name]),
        };
        return { shell: mockShell, env: mockEnv };
    }

    test("empty stdout — returns empty array", async () => {
        const deps = makeShellDeps([makeShellResult("")]);
        const result = await fetchChildren(deps, "owner", "repo", 5);
        expect(result).toEqual([]);
    });

    test("two sub-issues in NDJSON stdout — returns two IssueHeader objects", async () => {
        const lines = [
            makeRawSubIssue(10, "Issue A", "open", ["feature"]),
            makeRawSubIssue(20, "Issue B", "closed", ["bug"]),
        ].join("\n");
        const deps = makeShellDeps([makeShellResult(lines)]);
        const result = await fetchChildren(deps, "owner", "repo", 5);
        expect(result).toHaveLength(2);
        expect(result[0]!.number).toBe(10);
        expect(result[0]!.title).toBe("Issue A");
        expect(result[0]!.state).toBe("open");
        expect(result[1]!.number).toBe(20);
        expect(result[1]!.state).toBe("closed");
    });

    test("parent field is set to parentNumber argument", async () => {
        const lines = makeRawSubIssue(99, "Child", "open", []);
        const deps = makeShellDeps([makeShellResult(lines)]);
        const result = await fetchChildren(deps, "owner", "repo", 42);
        expect(result[0]!.parent).toBe(42);
    });

    test("issue with chore label — type is 'chore'", async () => {
        const lines = makeRawSubIssue(1, "Chore issue", "open", ["chore"]);
        const deps = makeShellDeps([makeShellResult(lines)]);
        const result = await fetchChildren(deps, "owner", "repo", 1);
        expect(result[0]!.type).toBe("chore");
    });

    test("issue with no type label — type is null", async () => {
        const lines = makeRawSubIssue(1, "Unlabeled", "open", ["phase: impl"]);
        const deps = makeShellDeps([makeShellResult(lines)]);
        const result = await fetchChildren(deps, "owner", "repo", 1);
        expect(result[0]!.type).toBeNull();
    });

    test("issue with phase label — phase matches full label string", async () => {
        const lines = makeRawSubIssue(1, "Phase issue", "open", ["feature", "phase: impl-plan"]);
        const deps = makeShellDeps([makeShellResult(lines)]);
        const result = await fetchChildren(deps, "owner", "repo", 1);
        expect(result[0]!.phase).toBe("phase: impl-plan");
    });

    test("issue with no phase label — phase is null", async () => {
        const lines = makeRawSubIssue(1, "No phase", "open", ["feature"]);
        const deps = makeShellDeps([makeShellResult(lines)]);
        const result = await fetchChildren(deps, "owner", "repo", 1);
        expect(result[0]!.phase).toBeNull();
    });

    test("blank lines in stdout are ignored", async () => {
        const lines = makeRawSubIssue(5, "Only one", "open", []) + "\n\n";
        const deps = makeShellDeps([makeShellResult(lines)]);
        const result = await fetchChildren(deps, "owner", "repo", 5);
        expect(result).toHaveLength(1);
    });
});
