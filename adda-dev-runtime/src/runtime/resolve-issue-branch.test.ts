import { describe, expect, mock, test } from "bun:test";
import type { Env, EnvDep, Shell, ShellDep, ShellResult, StdioDep } from "../lib/index";
import { ResolveIssueBranchScript } from "./resolve-issue-branch";

type ResolveIssueBranchDeps = ShellDep & EnvDep & StdioDep;

// --- GraphQL response builder ---

interface GraphQLLinkedBranch {
    ref: { name: string };
}

interface GraphQLTimelineNode {
    subject: { number: number; state: string; headRefName: string };
}

interface GraphQLIssue {
    linkedBranches: { nodes: GraphQLLinkedBranch[] };
    timelineItems: { nodes: GraphQLTimelineNode[] };
}

function makeGraphQLResponse(issue: GraphQLIssue | null): string {
    return JSON.stringify({
        data: {
            repository: {
                issue,
            },
        },
    });
}

function makeRawResponse(obj: unknown): string {
    return JSON.stringify(obj);
}

// --- Mock helpers ---

function makeMockDeps(options: { shellRun?: (command: string[]) => Promise<ShellResult>; envVars?: Record<string, string> }): {
    deps: ResolveIssueBranchDeps;
    outLines: string[];
    errLines: string[];
} {
    const outLines: string[] = [];
    const errLines: string[] = [];

    const defaultShellRun = async (): Promise<ShellResult> => ({
        stdout: makeGraphQLResponse({
            linkedBranches: { nodes: [] },
            timelineItems: { nodes: [] },
        }),
        stderr: "",
        exitCode: 0,
    });

    const mockShell: Shell = {
        run: mock(options.shellRun ?? defaultShellRun),
        runSh: mock(async (_cmd: string, _opts?: { strict?: boolean }) => ({ stdout: "", stderr: "", exitCode: 0 })),
    };

    const envVars = options.envVars ?? {
        GITHUB_OWNER: "testowner",
        GITHUB_REPO: "testrepo",
    };

    const mockEnv: Env = {
        get: mock((name: string) => envVars[name]),
    };

    const deps: ResolveIssueBranchDeps = {
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

    return { deps, outLines, errLines };
}

function parseStdoutJson(outLines: string[]): Record<string, unknown> {
    return JSON.parse(outLines.join("").trim()) as Record<string, unknown>;
}

// --- Tests ---

describe("ResolveIssueBranchScript", () => {
    describe("argument validation", () => {
        test("no positional arg — exits 2 with fail envelope", async () => {
            const { deps, outLines } = makeMockDeps({});
            const script = new ResolveIssueBranchScript(deps);
            const code = await script.run(["bun", "resolve-issue-branch.ts"]);
            expect(code).toBe(2);
            const out = parseStdoutJson(outLines);
            expect(out.status).toBe("fail");
            expect(out.result).toBeNull();
            const error = out.error as Record<string, unknown>;
            expect(error.reason).toBe("invalid_args");
        });

        test("too many args (2) — exits 2 with fail envelope", async () => {
            const { deps, outLines } = makeMockDeps({});
            const script = new ResolveIssueBranchScript(deps);
            const code = await script.run(["bun", "resolve-issue-branch.ts", "123", "456"]);
            expect(code).toBe(2);
            const out = parseStdoutJson(outLines);
            expect(out.status).toBe("fail");
            expect(out.result).toBeNull();
            const error = out.error as Record<string, unknown>;
            expect(error.reason).toBe("invalid_args");
        });
    });

    describe("environment variable validation", () => {
        test("missing GITHUB_OWNER — exits 1 with fail envelope, reason missing_env", async () => {
            const { deps, outLines } = makeMockDeps({
                envVars: { GITHUB_REPO: "testrepo" },
            });
            const script = new ResolveIssueBranchScript(deps);
            const code = await script.run(["bun", "resolve-issue-branch.ts", "132"]);
            expect(code).toBe(1);
            const out = parseStdoutJson(outLines);
            expect(out.status).toBe("fail");
            expect(out.result).toBeNull();
            const error = out.error as Record<string, unknown>;
            expect(error.reason).toBe("missing_env");
            expect(String(error.message)).toContain("GITHUB_OWNER");
        });

        test("missing GITHUB_REPO — exits 1 with fail envelope, reason missing_env", async () => {
            const { deps, outLines } = makeMockDeps({
                envVars: { GITHUB_OWNER: "testowner" },
            });
            const script = new ResolveIssueBranchScript(deps);
            const code = await script.run(["bun", "resolve-issue-branch.ts", "132"]);
            expect(code).toBe(1);
            const out = parseStdoutJson(outLines);
            expect(out.status).toBe("fail");
            expect(out.result).toBeNull();
            const error = out.error as Record<string, unknown>;
            expect(error.reason).toBe("missing_env");
            expect(String(error.message)).toContain("GITHUB_REPO");
        });
    });

    describe("gh shell command failure", () => {
        test("gh exits non-zero — exits 1 with fail envelope, reason api_error", async () => {
            const { deps, outLines } = makeMockDeps({
                shellRun: async () => ({
                    stdout: "",
                    stderr: "API rate limit exceeded",
                    exitCode: 1,
                }),
            });
            const script = new ResolveIssueBranchScript(deps);
            const code = await script.run(["bun", "resolve-issue-branch.ts", "132"]);
            expect(code).toBe(1);
            const out = parseStdoutJson(outLines);
            expect(out.status).toBe("fail");
            expect(out.result).toBeNull();
            const error = out.error as Record<string, unknown>;
            expect(error.reason).toBe("api_error");
            expect(String(error.message)).toContain("GraphQL API call failed");
        });
    });

    describe("invalid JSON response", () => {
        test("GraphQL response is not valid JSON — exits 1 with fail envelope, reason api_error", async () => {
            const { deps, outLines } = makeMockDeps({
                shellRun: async () => ({ stdout: "not valid json{{", stderr: "", exitCode: 0 }),
            });
            const exit = await new ResolveIssueBranchScript(deps).run(["bun", "script.ts", "42"]);
            expect(exit).toBe(1);
            const out = parseStdoutJson(outLines);
            expect(out.status).toBe("fail");
            expect(out.result).toBeNull();
            const error = out.error as Record<string, unknown>;
            expect(error.reason).toBe("api_error");
            expect(String(error.message)).toBe("invalid JSON");
        });
    });

    describe("issue not found", () => {
        test("null issue in response — exits 1 with fail envelope, reason issue_not_found", async () => {
            const { deps, outLines } = makeMockDeps({
                shellRun: async () => ({
                    stdout: makeGraphQLResponse(null),
                    stderr: "",
                    exitCode: 0,
                }),
            });
            const script = new ResolveIssueBranchScript(deps);
            const code = await script.run(["bun", "resolve-issue-branch.ts", "99999"]);
            expect(code).toBe(1);
            const out = parseStdoutJson(outLines);
            expect(out.status).toBe("fail");
            expect(out.result).toBeNull();
            const error = out.error as Record<string, unknown>;
            expect(error.reason).toBe("issue_not_found");
            expect(String(error.message)).toContain("99999");
        });
    });

    describe("structural validation", () => {
        test("data is null — exits 1 with fail envelope, reason validation_error", async () => {
            const { deps, outLines } = makeMockDeps({
                shellRun: async () => ({
                    stdout: makeRawResponse({ data: null }),
                    stderr: "",
                    exitCode: 0,
                }),
            });
            const script = new ResolveIssueBranchScript(deps);
            const code = await script.run(["bun", "resolve-issue-branch.ts", "132"]);
            expect(code).toBe(1);
            const out = parseStdoutJson(outLines);
            expect(out.status).toBe("fail");
            const error = out.error as Record<string, unknown>;
            expect(error.reason).toBe("validation_error");
        });

        test("data.repository is null — exits 1 with fail envelope, reason repo_not_found", async () => {
            const { deps, outLines } = makeMockDeps({
                shellRun: async () => ({
                    stdout: makeRawResponse({ data: { repository: null } }),
                    stderr: "",
                    exitCode: 0,
                }),
            });
            const script = new ResolveIssueBranchScript(deps);
            const code = await script.run(["bun", "resolve-issue-branch.ts", "132"]);
            expect(code).toBe(1);
            const out = parseStdoutJson(outLines);
            expect(out.status).toBe("fail");
            const error = out.error as Record<string, unknown>;
            expect(error.reason).toBe("repo_not_found");
        });

        test("data.repository.issue is null — exits 1 with fail envelope, reason issue_not_found", async () => {
            const { deps, outLines } = makeMockDeps({
                shellRun: async () => ({
                    stdout: makeRawResponse({ data: { repository: { issue: null } } }),
                    stderr: "",
                    exitCode: 0,
                }),
            });
            const script = new ResolveIssueBranchScript(deps);
            const code = await script.run(["bun", "resolve-issue-branch.ts", "132"]);
            expect(code).toBe(1);
            const out = parseStdoutJson(outLines);
            expect(out.status).toBe("fail");
            const error = out.error as Record<string, unknown>;
            expect(error.reason).toBe("issue_not_found");
        });

        test("linkedBranches is null — exits 1 with fail envelope, reason validation_error", async () => {
            const { deps, outLines } = makeMockDeps({
                shellRun: async () => ({
                    stdout: makeRawResponse({
                        data: { repository: { issue: { linkedBranches: null, timelineItems: { nodes: [] } } } },
                    }),
                    stderr: "",
                    exitCode: 0,
                }),
            });
            const script = new ResolveIssueBranchScript(deps);
            const code = await script.run(["bun", "resolve-issue-branch.ts", "132"]);
            expect(code).toBe(1);
            const out = parseStdoutJson(outLines);
            expect(out.status).toBe("fail");
            const error = out.error as Record<string, unknown>;
            expect(error.reason).toBe("validation_error");
        });

        test("linkedBranches.nodes is null — exits 1 with fail envelope, reason validation_error", async () => {
            const { deps, outLines } = makeMockDeps({
                shellRun: async () => ({
                    stdout: makeRawResponse({
                        data: { repository: { issue: { linkedBranches: { nodes: null }, timelineItems: { nodes: [] } } } },
                    }),
                    stderr: "",
                    exitCode: 0,
                }),
            });
            const script = new ResolveIssueBranchScript(deps);
            const code = await script.run(["bun", "resolve-issue-branch.ts", "132"]);
            expect(code).toBe(1);
            const out = parseStdoutJson(outLines);
            expect(out.status).toBe("fail");
            const error = out.error as Record<string, unknown>;
            expect(error.reason).toBe("validation_error");
        });

        test("timelineItems is null — exits 1 with fail envelope, reason validation_error", async () => {
            const { deps, outLines } = makeMockDeps({
                shellRun: async () => ({
                    stdout: makeRawResponse({
                        data: { repository: { issue: { linkedBranches: { nodes: [] }, timelineItems: null } } },
                    }),
                    stderr: "",
                    exitCode: 0,
                }),
            });
            const script = new ResolveIssueBranchScript(deps);
            const code = await script.run(["bun", "resolve-issue-branch.ts", "132"]);
            expect(code).toBe(1);
            const out = parseStdoutJson(outLines);
            expect(out.status).toBe("fail");
            const error = out.error as Record<string, unknown>;
            expect(error.reason).toBe("validation_error");
        });

        test("timelineItems.nodes is null — exits 1 with fail envelope, reason validation_error", async () => {
            const { deps, outLines } = makeMockDeps({
                shellRun: async () => ({
                    stdout: makeRawResponse({
                        data: { repository: { issue: { linkedBranches: { nodes: [] }, timelineItems: { nodes: null } } } },
                    }),
                    stderr: "",
                    exitCode: 0,
                }),
            });
            const script = new ResolveIssueBranchScript(deps);
            const code = await script.run(["bun", "resolve-issue-branch.ts", "132"]);
            expect(code).toBe(1);
            const out = parseStdoutJson(outLines);
            expect(out.status).toBe("fail");
            const error = out.error as Record<string, unknown>;
            expect(error.reason).toBe("validation_error");
        });
    });

    describe("linkedBranches resolution", () => {
        test("linkedBranches = 1 — exits 0 with ok envelope, resolution feature_branch (no pr)", async () => {
            const { deps, outLines } = makeMockDeps({
                shellRun: async () => ({
                    stdout: makeGraphQLResponse({
                        linkedBranches: {
                            nodes: [{ ref: { name: "feature/132-my-branch" } }],
                        },
                        timelineItems: { nodes: [] },
                    }),
                    stderr: "",
                    exitCode: 0,
                }),
            });
            const script = new ResolveIssueBranchScript(deps);
            const code = await script.run(["bun", "resolve-issue-branch.ts", "132"]);
            expect(code).toBe(0);
            const out = parseStdoutJson(outLines);
            expect(out.status).toBe("ok");
            expect(out.error).toBeNull();
            const result = out.result as Record<string, unknown>;
            expect(result.resolution).toBe("feature_branch");
            expect(result.branch).toBe("feature/132-my-branch");
            expect(result.pr).toBe("");
        });

        test("linkedBranches > 1 — exits 1 with fail envelope, reason ambiguous", async () => {
            const { deps, outLines } = makeMockDeps({
                shellRun: async () => ({
                    stdout: makeGraphQLResponse({
                        linkedBranches: {
                            nodes: [{ ref: { name: "feature/132-branch-a" } }, { ref: { name: "feature/132-branch-b" } }],
                        },
                        timelineItems: { nodes: [] },
                    }),
                    stderr: "",
                    exitCode: 0,
                }),
            });
            const script = new ResolveIssueBranchScript(deps);
            const code = await script.run(["bun", "resolve-issue-branch.ts", "132"]);
            expect(code).toBe(1);
            const out = parseStdoutJson(outLines);
            expect(out.status).toBe("fail");
            expect(out.result).toBeNull();
            const error = out.error as Record<string, unknown>;
            expect(error.reason).toBe("ambiguous_result");
        });
    });

    describe("CONNECTED_EVENT open PR fallback", () => {
        test("linkedBranches = 0, open PRs = 0 — exits 0 with ok envelope, resolution main", async () => {
            const { deps, outLines } = makeMockDeps({
                shellRun: async () => ({
                    stdout: makeGraphQLResponse({
                        linkedBranches: { nodes: [] },
                        timelineItems: { nodes: [] },
                    }),
                    stderr: "",
                    exitCode: 0,
                }),
            });
            const script = new ResolveIssueBranchScript(deps);
            const code = await script.run(["bun", "resolve-issue-branch.ts", "126"]);
            expect(code).toBe(0);
            const out = parseStdoutJson(outLines);
            expect(out.status).toBe("ok");
            expect(out.error).toBeNull();
            const result = out.result as Record<string, unknown>;
            expect(result.resolution).toBe("main");
            expect(result.branch).toBe("");
            expect(result.pr).toBe("");
        });

        test("linkedBranches = 0, open PRs = 1 — exits 0 with ok envelope, resolution feature_branch with pr number", async () => {
            const { deps, outLines } = makeMockDeps({
                shellRun: async () => ({
                    stdout: makeGraphQLResponse({
                        linkedBranches: { nodes: [] },
                        timelineItems: {
                            nodes: [
                                {
                                    subject: {
                                        number: 45,
                                        state: "OPEN",
                                        headRefName: "feature/132-via-pr",
                                    },
                                },
                            ],
                        },
                    }),
                    stderr: "",
                    exitCode: 0,
                }),
            });
            const script = new ResolveIssueBranchScript(deps);
            const code = await script.run(["bun", "resolve-issue-branch.ts", "132"]);
            expect(code).toBe(0);
            const out = parseStdoutJson(outLines);
            expect(out.status).toBe("ok");
            expect(out.error).toBeNull();
            const result = out.result as Record<string, unknown>;
            expect(result.resolution).toBe("feature_branch");
            expect(result.branch).toBe("feature/132-via-pr");
            expect(result.pr).toBe("45");
        });

        test("linkedBranches = 0, open PRs > 1 — exits 1 with fail envelope, reason ambiguous", async () => {
            const { deps, outLines } = makeMockDeps({
                shellRun: async () => ({
                    stdout: makeGraphQLResponse({
                        linkedBranches: { nodes: [] },
                        timelineItems: {
                            nodes: [
                                {
                                    subject: {
                                        number: 45,
                                        state: "OPEN",
                                        headRefName: "feature/132-pr-a",
                                    },
                                },
                                {
                                    subject: {
                                        number: 46,
                                        state: "OPEN",
                                        headRefName: "feature/132-pr-b",
                                    },
                                },
                            ],
                        },
                    }),
                    stderr: "",
                    exitCode: 0,
                }),
            });
            const script = new ResolveIssueBranchScript(deps);
            const code = await script.run(["bun", "resolve-issue-branch.ts", "132"]);
            expect(code).toBe(1);
            const out = parseStdoutJson(outLines);
            expect(out.status).toBe("fail");
            expect(out.result).toBeNull();
            const error = out.error as Record<string, unknown>;
            expect(error.reason).toBe("ambiguous_result");
        });

        test("closed PRs in timelineItems are ignored when counting open PRs", async () => {
            const { deps, outLines } = makeMockDeps({
                shellRun: async () => ({
                    stdout: makeGraphQLResponse({
                        linkedBranches: { nodes: [] },
                        timelineItems: {
                            nodes: [
                                {
                                    subject: {
                                        number: 40,
                                        state: "CLOSED",
                                        headRefName: "feature/132-closed",
                                    },
                                },
                                {
                                    subject: {
                                        number: 45,
                                        state: "OPEN",
                                        headRefName: "feature/132-open",
                                    },
                                },
                            ],
                        },
                    }),
                    stderr: "",
                    exitCode: 0,
                }),
            });
            const script = new ResolveIssueBranchScript(deps);
            const code = await script.run(["bun", "resolve-issue-branch.ts", "132"]);
            expect(code).toBe(0);
            const out = parseStdoutJson(outLines);
            expect(out.status).toBe("ok");
            expect(out.error).toBeNull();
            const result = out.result as Record<string, unknown>;
            expect(result.resolution).toBe("feature_branch");
            expect(result.branch).toBe("feature/132-open");
            expect(result.pr).toBe("45");
        });
    });
});
