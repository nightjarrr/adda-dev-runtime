import { describe, expect, mock, test } from "bun:test";
import type { Env, EnvDep, Shell, ShellDep, ShellResult, StdioDep } from "../lib/index";
import { ScriptShellError } from "../lib/index";
import { IssueHierarchyScript } from "./issue-hierarchy";
import { fetchChildren, RawIssueSchema } from "./issue-hierarchy/children";
import { fetchParent, runParent } from "./issue-hierarchy/parent";

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

// --- Raw issue builder (for /issues/{n} responses) ---

function makeRawIssue(
    number: number,
    title: string,
    state: "open" | "closed",
    id: number,
    labels: string[],
    parent_issue_url: string | null,
): string {
    return JSON.stringify({
        number,
        title,
        state,
        id,
        labels: labels.map((name) => ({ name })),
        parent_issue_url,
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

        // --- parent argument validation ---

        test("parent without number — exits 2", async () => {
            const { deps, outLines } = makeMockDeps();
            const code = await new IssueHierarchyScript(deps).run(["bun", "issue-hierarchy.ts", "parent"]);
            expect(code).toBe(2);
            const out = getStdoutJson(outLines) as Record<string, unknown>;
            expect(out.status).toBe("fail");
            expect((out.error as Record<string, unknown>)?.reason).toBe("invalid_args");
        });

        test("parent nan issue number — exits 2", async () => {
            const { deps, outLines } = makeMockDeps();
            const code = await new IssueHierarchyScript(deps).run(["bun", "issue-hierarchy.ts", "parent", "abc"]);
            expect(code).toBe(2);
            const out = getStdoutJson(outLines) as Record<string, unknown>;
            expect(out.status).toBe("fail");
            expect((out.error as Record<string, unknown>)?.reason).toBe("invalid_args");
        });

        test("parent 0 issue number — exits 2 (non-positive)", async () => {
            const { deps, outLines } = makeMockDeps();
            const code = await new IssueHierarchyScript(deps).run(["bun", "issue-hierarchy.ts", "parent", "0"]);
            expect(code).toBe(2);
            const out = getStdoutJson(outLines) as Record<string, unknown>;
            expect(out.status).toBe("fail");
        });

        test("parent -1 issue number — exits 2 (negative)", async () => {
            const { deps, outLines } = makeMockDeps();
            const code = await new IssueHierarchyScript(deps).run(["bun", "issue-hierarchy.ts", "parent", "-1"]);
            expect(code).toBe(2);
            const out = getStdoutJson(outLines) as Record<string, unknown>;
            expect(out.status).toBe("fail");
        });

        test("parent --set with NaN — exits 2", async () => {
            const { deps, outLines } = makeMockDeps();
            const code = await new IssueHierarchyScript(deps).run(["bun", "issue-hierarchy.ts", "parent", "5", "--set", "abc"]);
            expect(code).toBe(2);
            const out = getStdoutJson(outLines) as Record<string, unknown>;
            expect(out.status).toBe("fail");
            expect((out.error as Record<string, unknown>)?.reason).toBe("invalid_args");
        });

        test("parent --set with 0 — exits 2", async () => {
            const { deps, outLines } = makeMockDeps();
            const code = await new IssueHierarchyScript(deps).run(["bun", "issue-hierarchy.ts", "parent", "5", "--set", "0"]);
            expect(code).toBe(2);
            const out = getStdoutJson(outLines) as Record<string, unknown>;
            expect(out.status).toBe("fail");
        });

        test("parent --set with negative number — exits 2", async () => {
            const { deps, outLines } = makeMockDeps();
            const code = await new IssueHierarchyScript(deps).run(["bun", "issue-hierarchy.ts", "parent", "5", "--set", "-3"]);
            expect(code).toBe(2);
            const out = getStdoutJson(outLines) as Record<string, unknown>;
            expect(out.status).toBe("fail");
        });

        test("parent --set NONE (case-insensitive) — passes validation as null", async () => {
            const { deps } = makeMockDeps({
                runQueue: [
                    makeShellResult(makeRawIssue(5, "Test", "open", 1001, ["feature"], null)),
                    makeShellResult(makeRawIssue(5, "Test", "open", 1001, ["feature"], null)),
                ],
            });
            const code = await new IssueHierarchyScript(deps).run([
                "bun",
                "issue-hierarchy.ts",
                "parent",
                "5",
                "--set",
                "NONE",
            ]);
            // No parent to remove, so it just re-fetches
            expect(code).toBe(0);
        });
    });

    // ---------------------------------------------------------------
    // Integration tests — children subcommand (via script.run)
    // ---------------------------------------------------------------
    describe("children integration", () => {
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

    // ---------------------------------------------------------------
    // Integration tests — parent subcommand (via script.run)
    // ---------------------------------------------------------------
    describe("parent integration", () => {
        test("parent <n> with no parent — exit 0, ok envelope with null parent", async () => {
            const { deps, outLines } = makeMockDeps({
                runQueue: [
                    makeShellResult(makeRawIssue(42, "Test issue", "open", 500, ["feature"], null)),
                    makeShellResult(makeRawIssue(42, "Test issue", "open", 500, ["feature"], null)),
                ],
            });
            const code = await new IssueHierarchyScript(deps).run(["bun", "issue-hierarchy.ts", "parent", "42"]);
            expect(code).toBe(0);
            const out = getStdoutJson(outLines) as {
                status: string;
                result: { issue: number; parent: null };
                error: null;
            };
            expect(out.status).toBe("ok");
            expect(out.result.issue).toBe(42);
            expect(out.result.parent).toBeNull();
        });

        test("parent <n> with existing parent — exit 0, ok envelope with parent header", async () => {
            const { deps, outLines } = makeMockDeps({
                runQueue: [
                    // fetchIssueById (child)
                    makeShellResult(
                        makeRawIssue(42, "Child issue", "open", 500, ["bug"], "https://api.github.com/repos/o/r/issues/10"),
                    ),
                    // fetchIssueById inside fetchParent (child again — to get parent_issue_url)
                    makeShellResult(
                        makeRawIssue(42, "Child issue", "open", 500, ["bug"], "https://api.github.com/repos/o/r/issues/10"),
                    ),
                    // fetchParent fetches the parent
                    makeShellResult(makeRawIssue(10, "Parent issue", "open", 100, ["feature"], null)),
                ],
            });
            const code = await new IssueHierarchyScript(deps).run(["bun", "issue-hierarchy.ts", "parent", "42"]);
            expect(code).toBe(0);
            const out = getStdoutJson(outLines) as {
                status: string;
                result: { issue: number; parent: { number: number; title: string } };
                error: null;
            };
            expect(out.status).toBe("ok");
            expect(out.result.issue).toBe(42);
            expect(out.result.parent.number).toBe(10);
            expect(out.result.parent.title).toBe("Parent issue");
        });

        test("parent <n> --set <m> — exit 0, sets parent and verifies", async () => {
            // First fetchIssueById (no parent), then POST, then fetchParent:
            //   fetchIssueById (no parent url), then fetchParent returns null
            const { deps, outLines } = makeMockDeps({
                runQueue: [
                    makeShellResult(makeRawIssue(5, "Child", "open", 88, ["bug"], null)),
                    makeShellResult(""), // POST response
                    makeShellResult(
                        makeRawIssue(5, "Child", "open", 88, ["bug"], "https://api.github.com/repos/o/r/issues/10"),
                    ),
                    makeShellResult(makeRawIssue(10, "Parent", "open", 99, ["feature"], null)),
                ],
            });
            const code = await new IssueHierarchyScript(deps).run(["bun", "issue-hierarchy.ts", "parent", "5", "--set", "10"]);
            expect(code).toBe(0);
            const out = getStdoutJson(outLines) as {
                status: string;
                result: { issue: number; parent: { number: number } };
                error: null;
            };
            expect(out.status).toBe("ok");
            expect(out.result.issue).toBe(5);
            expect(out.result.parent.number).toBe(10);
        });

        test("parent <n> --set NONE with existing parent — exit 0, removes parent", async () => {
            const { deps, outLines } = makeMockDeps({
                runQueue: [
                    // fetchIssueById: has parent
                    makeShellResult(
                        makeRawIssue(5, "Child", "open", 88, ["bug"], "https://api.github.com/repos/o/r/issues/10"),
                    ),
                    // DELETE sub_issue
                    makeShellResult(""),
                    // Re-fetch (fetchIssueById from fetchParent): no parent
                    makeShellResult(makeRawIssue(5, "Child", "open", 88, ["bug"], null)),
                ],
            });
            const code = await new IssueHierarchyScript(deps).run([
                "bun",
                "issue-hierarchy.ts",
                "parent",
                "5",
                "--set",
                "NONE",
            ]);
            expect(code).toBe(0);
            const out = getStdoutJson(outLines) as {
                status: string;
                result: { issue: number; parent: null };
                error: null;
            };
            expect(out.status).toBe("ok");
            expect(out.result.issue).toBe(5);
            expect(out.result.parent).toBeNull();
        });

        test("gh api error — exit 1, shell_error reason", async () => {
            const { deps, outLines } = makeMockDeps({
                runQueue: [makeShellResult("", 1, "HTTP 404")],
            });
            const code = await new IssueHierarchyScript(deps).run(["bun", "issue-hierarchy.ts", "parent", "999"]);
            expect(code).toBe(1);
            const out = getStdoutJson(outLines) as Record<string, unknown>;
            expect(out.status).toBe("fail");
            expect((out.error as Record<string, unknown>)?.reason).toBe("shell_error");
        });

        test("missing env — exit 1, missing_env reason", async () => {
            const { deps, outLines } = makeMockDeps({ envVars: {} });
            const code = await new IssueHierarchyScript(deps).run(["bun", "issue-hierarchy.ts", "parent", "1"]);
            expect(code).toBe(1);
            const out = getStdoutJson(outLines) as Record<string, unknown>;
            expect(out.status).toBe("fail");
            expect((out.error as Record<string, unknown>)?.reason).toBe("missing_env");
        });
    });

    // ---------------------------------------------------------------
    // Parent write verification failure tests
    // ---------------------------------------------------------------
    describe("parent write verification", () => {
        test("POST succeeds but fetch returns wrong parent — exit 1, internal_error", async () => {
            const { deps, outLines } = makeMockDeps({
                runQueue: [
                    makeShellResult(makeRawIssue(5, "Child", "open", 88, ["bug"], null)),
                    // POST
                    makeShellResult(""),
                    // Re-fetch: returns parent 20 instead of expected 10
                    makeShellResult(
                        makeRawIssue(5, "Child", "open", 88, ["bug"], "https://api.github.com/repos/o/r/issues/20"),
                    ),
                    makeShellResult(makeRawIssue(20, "Wrong", "open", 200, [], null)),
                ],
            });
            const code = await new IssueHierarchyScript(deps).run(["bun", "issue-hierarchy.ts", "parent", "5", "--set", "10"]);
            expect(code).toBe(1);
            const out = getStdoutJson(outLines) as Record<string, unknown>;
            expect(out.status).toBe("fail");
            expect((out.error as Record<string, unknown>)?.reason).toBe("internal_error");
        });

        test("set NONE but parent still present — exit 1, internal_error", async () => {
            const { deps, outLines } = makeMockDeps({
                runQueue: [
                    makeShellResult(
                        makeRawIssue(5, "Child", "open", 88, ["bug"], "https://api.github.com/repos/o/r/issues/10"),
                    ),
                    // DELETE
                    makeShellResult(""),
                    // Re-fetch: parent still present
                    makeShellResult(
                        makeRawIssue(5, "Child", "open", 88, ["bug"], "https://api.github.com/repos/o/r/issues/10"),
                    ),
                    makeShellResult(makeRawIssue(10, "Parent", "open", 99, [], null)),
                ],
            });
            const code = await new IssueHierarchyScript(deps).run([
                "bun",
                "issue-hierarchy.ts",
                "parent",
                "5",
                "--set",
                "NONE",
            ]);
            expect(code).toBe(1);
            const out = getStdoutJson(outLines) as Record<string, unknown>;
            expect(out.status).toBe("fail");
            expect((out.error as Record<string, unknown>)?.reason).toBe("internal_error");
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
        const result = await fetchChildren(deps, 5);
        expect(result).toEqual([]);
    });

    test("two sub-issues in NDJSON stdout — returns two IssueHeader objects", async () => {
        const lines = [
            makeRawSubIssue(10, "Issue A", "open", ["feature"]),
            makeRawSubIssue(20, "Issue B", "closed", ["bug"]),
        ].join("\n");
        const deps = makeShellDeps([makeShellResult(lines)]);
        const result = await fetchChildren(deps, 5);
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
        const result = await fetchChildren(deps, 42);
        expect(result[0]!.parent).toBe(42);
    });

    test("issue with chore label — type is 'chore'", async () => {
        const lines = makeRawSubIssue(1, "Chore issue", "open", ["chore"]);
        const deps = makeShellDeps([makeShellResult(lines)]);
        const result = await fetchChildren(deps, 1);
        expect(result[0]!.type).toBe("chore");
    });

    test("issue with no type label — type is null", async () => {
        const lines = makeRawSubIssue(1, "Unlabeled", "open", ["phase: impl"]);
        const deps = makeShellDeps([makeShellResult(lines)]);
        const result = await fetchChildren(deps, 1);
        expect(result[0]!.type).toBeNull();
    });

    test("issue with phase label — phase matches full label string", async () => {
        const lines = makeRawSubIssue(1, "Phase issue", "open", ["feature", "phase: impl-plan"]);
        const deps = makeShellDeps([makeShellResult(lines)]);
        const result = await fetchChildren(deps, 1);
        expect(result[0]!.phase).toBe("phase: impl-plan");
    });

    test("issue with no phase label — phase is null", async () => {
        const lines = makeRawSubIssue(1, "No phase", "open", ["feature"]);
        const deps = makeShellDeps([makeShellResult(lines)]);
        const result = await fetchChildren(deps, 1);
        expect(result[0]!.phase).toBeNull();
    });

    test("blank lines in stdout are ignored", async () => {
        const lines = makeRawSubIssue(5, "Only one", "open", []) + "\n\n";
        const deps = makeShellDeps([makeShellResult(lines)]);
        const result = await fetchChildren(deps, 5);
        expect(result).toHaveLength(1);
    });

    test("invalid JSON in response — throws ScriptZodValidationError", async () => {
        const deps = makeShellDeps([makeShellResult("not json")]);
        await expect(fetchChildren(deps, 5)).rejects.toThrow();
    });
});

// ---------------------------------------------------------------
// RawIssueSchema unit tests
// ---------------------------------------------------------------

describe("RawIssueSchema", () => {
    test("valid input passes", () => {
        const result = RawIssueSchema.safeParse({
            number: 1,
            title: "Test",
            state: "open",
            labels: [{ name: "bug" }],
        });
        expect(result.success).toBe(true);
    });

    test("invalid state fails", () => {
        const result = RawIssueSchema.safeParse({
            number: 1,
            title: "Test",
            state: "OPEN",
            labels: [],
        });
        expect(result.success).toBe(false);
    });

    test("missing number fails", () => {
        const result = RawIssueSchema.safeParse({
            title: "Test",
            state: "open",
            labels: [],
        });
        expect(result.success).toBe(false);
    });

    test("missing labels fails", () => {
        const result = RawIssueSchema.safeParse({
            number: 1,
            title: "Test",
            state: "open",
        });
        expect(result.success).toBe(false);
    });
});

// ---------------------------------------------------------------
// fetchParent unit tests
// ---------------------------------------------------------------

describe("fetchParent", () => {
    function makeDeps(runQueue: ShellResult[]): ShellDep & EnvDep {
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

    test("no parent — returns null", async () => {
        const deps = makeDeps([makeShellResult(makeRawIssue(1, "Root issue", "open", 10, ["feature"], null))]);
        const result = await fetchParent(deps, 1);
        expect(result).toBeNull();
    });

    test("has parent — returns parent GitHubIssueHeader", async () => {
        const deps = makeDeps([
            makeShellResult(makeRawIssue(5, "Child", "open", 50, ["bug"], "https://api.github.com/repos/o/r/issues/10")),
            makeShellResult(makeRawIssue(10, "Parent", "open", 100, ["feature"], null)),
        ]);
        const result = await fetchParent(deps, 5);
        expect(result).not.toBeNull();
        expect(result!.number).toBe(10);
        expect(result!.title).toBe("Parent");
    });

    test("parent with labels — preserves labels in result", async () => {
        const deps = makeDeps([
            makeShellResult(makeRawIssue(5, "Child", "open", 50, ["bug"], "https://api.github.com/repos/o/r/issues/10")),
            makeShellResult(makeRawIssue(10, "Parent", "open", 100, ["feature", "phase: planning"], null)),
        ]);
        const result = await fetchParent(deps, 5);
        expect(result!.labels).toEqual(["feature", "phase: planning"]);
        expect(result!.type).toBe("feature");
        expect(result!.phase).toBe("phase: planning");
    });

    test("invalid JSON from gh api — throws ScriptZodValidationError", async () => {
        const deps = makeDeps([makeShellResult("not json")]);
        await expect(fetchParent(deps, 1)).rejects.toThrow();
    });
});

// ---------------------------------------------------------------
// runParent unit tests
// ---------------------------------------------------------------

describe("runParent", () => {
    function makeDeps(runQueue: ShellResult[]): ShellDep & EnvDep {
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

    // --- Read (no --set) ---

    test("read: no parent — returns null parent", async () => {
        const deps = makeDeps([
            // runParent calls fetchIssueById
            makeShellResult(makeRawIssue(1, "Root", "open", 10, [], null)),
            // fetchParent calls fetchIssueById (child again)
            makeShellResult(makeRawIssue(1, "Root", "open", 10, [], null)),
        ]);
        const result = await runParent(deps, { subcommand: "parent", issueNumber: 1 });
        expect(result.issue).toBe(1);
        expect(result.parent).toBeNull();
    });

    test("read: has parent — returns parent header", async () => {
        const deps = makeDeps([
            // runParent calls fetchIssueById
            makeShellResult(makeRawIssue(5, "Child", "open", 50, [], "https://api.github.com/repos/o/r/issues/3")),
            // fetchParent calls fetchIssueById
            makeShellResult(makeRawIssue(5, "Child", "open", 50, [], "https://api.github.com/repos/o/r/issues/3")),
            // fetchParent fetches the parent issue
            makeShellResult(makeRawIssue(3, "Parent", "open", 30, ["feature"], null)),
        ]);
        const result = await runParent(deps, { subcommand: "parent", issueNumber: 5 });
        expect(result.parent).not.toBeNull();
        expect(result.parent!.number).toBe(3);
    });

    // --- Set (--set <n>) ---

    test("set: sets parent on issue without parent — issues POST and verifies", async () => {
        // fetchIssueById (no parent) → POST → fetchParent:
        //   fetchIssueById (now has parent url) → fetch parent issue
        const deps = makeDeps([
            makeShellResult(makeRawIssue(7, "Orphan", "open", 77, [], null)),
            makeShellResult(""), // POST response
            makeShellResult(makeRawIssue(7, "Orphan", "open", 77, [], "https://api.github.com/repos/o/r/issues/2")),
            makeShellResult(makeRawIssue(2, "New parent", "open", 22, ["feature"], null)),
        ]);
        const result = await runParent(deps, { subcommand: "parent", issueNumber: 7, setParent: 2 });
        expect(result.issue).toBe(7);
        expect(result.parent).not.toBeNull();
        expect(result.parent!.number).toBe(2);
    });

    test("set: sets parent on issue with existing parent — POST with replace", async () => {
        const deps = makeDeps([
            makeShellResult(makeRawIssue(7, "Child", "open", 77, [], "https://api.github.com/repos/o/r/issues/1")),
            makeShellResult(""), // POST with replace
            makeShellResult(makeRawIssue(7, "Child", "open", 77, [], "https://api.github.com/repos/o/r/issues/3")),
            makeShellResult(makeRawIssue(3, "Replacement", "open", 33, [], null)),
        ]);
        const result = await runParent(deps, { subcommand: "parent", issueNumber: 7, setParent: 3 });
        expect(result.parent!.number).toBe(3);
    });

    // --- Remove (--set NONE) ---

    test("remove: issue with parent — issues DELETE and verifies removal", async () => {
        const deps = makeDeps([
            // fetchIssueById: has parent
            makeShellResult(makeRawIssue(4, "Child", "open", 44, [], "https://api.github.com/repos/o/r/issues/1")),
            makeShellResult(""), // DELETE response
            // fetchParent: fetchIssueById (no parent anymore)
            makeShellResult(makeRawIssue(4, "Child", "open", 44, [], null)),
        ]);
        const result = await runParent(deps, { subcommand: "parent", issueNumber: 4, setParent: null });
        expect(result.parent).toBeNull();
    });

    test("remove: issue without parent (root) — no-op, no DELETE issued", async () => {
        const deps = makeDeps([
            // fetchIssueById: no parent
            makeShellResult(makeRawIssue(4, "Root", "open", 44, [], null)),
            // fetchParent: fetchIssueById (still no parent)
            makeShellResult(makeRawIssue(4, "Root", "open", 44, [], null)),
        ]);
        const result = await runParent(deps, { subcommand: "parent", issueNumber: 4, setParent: null });
        expect(result.parent).toBeNull();
    });

    // --- Verification failures ---

    test("verification: POST succeeds but fetch returns wrong parent — ScriptError internal_error", async () => {
        const deps = makeDeps([
            makeShellResult(makeRawIssue(5, "Child", "open", 55, [], null)),
            makeShellResult(""), // POST response
            // fetchParent: fetchIssueById returns parent url 20
            makeShellResult(makeRawIssue(5, "Child", "open", 55, [], "https://api.github.com/repos/o/r/issues/20")),
            makeShellResult(makeRawIssue(20, "Wrong", "open", 200, [], null)),
        ]);
        const err = await runParent(deps, { subcommand: "parent", issueNumber: 5, setParent: 10 }).catch((e) => e);
        expect(err.reason).toBe("internal_error");
    });

    test("verification: set NONE but parent still present — ScriptError internal_error", async () => {
        const deps = makeDeps([
            makeShellResult(makeRawIssue(5, "Child", "open", 55, [], "https://api.github.com/repos/o/r/issues/1")),
            makeShellResult(""), // DELETE response
            // fetchParent: parent still present
            makeShellResult(makeRawIssue(5, "Child", "open", 55, [], "https://api.github.com/repos/o/r/issues/1")),
            makeShellResult(makeRawIssue(1, "Still there", "open", 11, [], null)),
        ]);
        const err = await runParent(deps, { subcommand: "parent", issueNumber: 5, setParent: null }).catch((e) => e);
        expect(err.reason).toBe("internal_error");
    });

    // --- Error handling ---

    test("missing env — ScriptError missing_env", async () => {
        const emptyDeps: ShellDep & EnvDep = {
            shell: null as unknown as Shell,
            env: { get: mock(() => undefined) },
        };
        await expect(runParent(emptyDeps, { subcommand: "parent", issueNumber: 1 })).rejects.toThrow("GITHUB_OWNER");
    });
});

// ---------------------------------------------------------------
// Exports
// ---------------------------------------------------------------

describe("exports", () => {
    test("fetchChildren is exported from entrypoint", async () => {
        const { fetchChildren: exportedFetch } = await import("./issue-hierarchy");
        expect(exportedFetch).toBeFunction();
    });

    test("fetchParent is exported from entrypoint", async () => {
        const { fetchParent: exportedFetch } = await import("./issue-hierarchy");
        expect(exportedFetch).toBeFunction();
    });
});
