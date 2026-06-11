import { describe, expect, mock, test } from "bun:test";
import type {
    Env,
    EnvDep,
    FileWriter,
    FileWriterDep,
    FileSys,
    FileSysDep,
    Shell,
    ShellDep,
    ShellResult,
    StdioDep,
    Tmp,
    TmpDep,
} from "../lib/index";
import { PrReviewThreadsScript } from "./pr-review-threads";

type PrReviewThreadsDeps = ShellDep & EnvDep & StdioDep & TmpDep & FileWriterDep & FileSysDep;

// --- Mock helpers ---

function makeShellResult(stdout: string, exitCode = 0, stderr = ""): ShellResult {
    return { stdout, stderr, exitCode };
}

interface MockDepsOptions {
    runQueue?: ShellResult[];
    envVars?: Record<string, string>;
    tmpDirValue?: string;
}

interface MockDepsResult {
    deps: PrReviewThreadsDeps;
    outLines: string[];
    errLines: string[];
    runCalls: string[][];
    writtenFiles: Map<string, string>;
    renamedFiles: Array<{ from: string; to: string }>;
}

function makeMockDeps(options: MockDepsOptions = {}): MockDepsResult {
    const outLines: string[] = [];
    const errLines: string[] = [];
    const runCalls: string[][] = [];
    const writtenFiles = new Map<string, string>();
    const renamedFiles: Array<{ from: string; to: string }> = [];

    const runQueue = options.runQueue ? [...options.runQueue] : [];

    const mockShell: Shell = {
        run: mock(async (command: string[], opts?: { strict?: boolean }) => {
            runCalls.push(command);
            const result = runQueue.shift() ?? makeShellResult("{}");
            if ((opts?.strict ?? true) && result.exitCode !== 0) {
                const err = new Error(`shell command failed (exit ${result.exitCode}): ${command.join(" ")}`);
                throw err;
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

    let tmpCounter = 0;
    const tmpDirValue = options.tmpDirValue ?? "/tmp";
    const mockTmp: Tmp = {
        tempFilePath: mock((prefix = "tmp", suffix = "") => {
            tmpCounter++;
            return `${tmpDirValue}/${prefix}-test-uuid-${tmpCounter}${suffix}`;
        }),
        makeTempDir: mock(() => `${tmpDirValue}/test-dir`),
        tmpDir: mock(() => tmpDirValue),
    };

    const mockFileWriter: FileWriter = {
        writeFile: mock(async (path: string, content: string): Promise<void> => {
            writtenFiles.set(path, content);
        }),
    };

    const mockFileSys: FileSys = {
        renameFile: mock(async (from: string, to: string): Promise<void> => {
            renamedFiles.push({ from, to });
        }),
        deleteFile: mock(async () => {}),
        fileExists: mock(async () => false),
    };

    const deps: PrReviewThreadsDeps = {
        shell: mockShell,
        env: mockEnv,
        tmp: mockTmp,
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

    return { deps, outLines, errLines, runCalls, writtenFiles, renamedFiles };
}

function getStdoutJson(outLines: string[]): unknown {
    return JSON.parse(outLines.join("").trim()) as unknown;
}

// --- GraphQL response builders ---

interface ThreadCommentInput {
    login?: string;
    body?: string;
    url?: string;
    createdAt?: string;
    diffHunk?: string;
}

function makeComment(opts: ThreadCommentInput = {}): object {
    return {
        author: { login: opts.login ?? "user" },
        body: opts.body ?? "comment body",
        url: opts.url ?? "https://github.com/owner/repo/pull/1#discussion_r1",
        createdAt: opts.createdAt ?? "2026-01-01T00:00:00Z",
        diffHunk: opts.diffHunk ?? "@@ -1,3 +1,4 @@\n line1\n line2\n-old\n+new",
    };
}

interface ThreadInput {
    id?: string;
    isResolved?: boolean;
    isOutdated?: boolean;
    path?: string;
    line?: number | null;
    startLine?: number | null;
    originalLine?: number | null;
    diffSide?: string;
    comments?: object[];
    commentsTotalCount?: number;
    commentsHasNextPage?: boolean;
}

function makeThread(opts: ThreadInput = {}): object {
    const commentNodes = opts.comments ?? [makeComment()];
    return {
        id: opts.id ?? "PRRT_test123",
        isResolved: opts.isResolved ?? false,
        isOutdated: opts.isOutdated ?? false,
        path: opts.path ?? "src/index.ts",
        line: opts.line !== undefined ? opts.line : 10,
        startLine: opts.startLine !== undefined ? opts.startLine : null,
        originalLine: opts.originalLine !== undefined ? opts.originalLine : 10,
        diffSide: opts.diffSide ?? "RIGHT",
        comments: {
            totalCount: opts.commentsTotalCount ?? commentNodes.length,
            pageInfo: { hasNextPage: opts.commentsHasNextPage ?? false },
            nodes: commentNodes,
        },
    };
}

function makePrThreadsResponse(
    threads: object[],
    totalCount?: number,
    hasNextPage = false,
    endCursor: string | null = null,
): string {
    return JSON.stringify({
        data: {
            repository: {
                pullRequest: {
                    reviewThreads: {
                        totalCount: totalCount ?? threads.length,
                        pageInfo: { hasNextPage, endCursor },
                        nodes: threads,
                    },
                },
            },
        },
    });
}

function makeRepoNotFound(): string {
    return JSON.stringify({ data: { repository: null } });
}

function makePrNotFound(): string {
    return JSON.stringify({ data: { repository: { pullRequest: null } } });
}

function makeThreadNodeResponse(
    opts: {
        id?: string;
        typename?: string;
        isResolved?: boolean;
        isOutdated?: boolean;
        path?: string;
        line?: number | null;
        startLine?: number | null;
        originalLine?: number | null;
        diffSide?: string;
        prNumber?: number;
        comments?: object[];
        commentsTotalCount?: number;
        commentsHasNextPage?: boolean;
        endCursor?: string | null;
    } = {},
): string {
    const commentNodes = opts.comments ?? [makeComment()];
    return JSON.stringify({
        data: {
            node: {
                __typename: opts.typename ?? "PullRequestReviewThread",
                isResolved: opts.isResolved ?? false,
                isOutdated: opts.isOutdated ?? false,
                path: opts.path ?? "src/index.ts",
                line: opts.line !== undefined ? opts.line : 10,
                startLine: opts.startLine !== undefined ? opts.startLine : null,
                originalLine: opts.originalLine !== undefined ? opts.originalLine : 10,
                diffSide: opts.diffSide ?? "RIGHT",
                pullRequest: { number: opts.prNumber ?? 303 },
                comments: {
                    totalCount: opts.commentsTotalCount ?? commentNodes.length,
                    pageInfo: {
                        hasNextPage: opts.commentsHasNextPage ?? false,
                        endCursor: opts.endCursor ?? null,
                    },
                    nodes: commentNodes,
                },
            },
        },
    });
}

function makeThreadNodeNotFound(): string {
    return JSON.stringify({ data: { node: null } });
}

// --- Tests ---

describe("PrReviewThreadsScript", () => {
    // ---------------------------------------------------------------
    // Argument validation / dispatch
    // ---------------------------------------------------------------
    describe("argument validation", () => {
        test("no args — exits 2, structured envelope on stdout", async () => {
            const { deps, outLines } = makeMockDeps();
            const code = await new PrReviewThreadsScript(deps).run(["bun", "pr-review-threads.ts"]);
            expect(code).toBe(2);
            const out = getStdoutJson(outLines) as Record<string, unknown>;
            expect(out.status).toBe("error");
            expect(out.error).toBeString();
            expect(out).not.toHaveProperty("pr");
            expect(out).not.toHaveProperty("thread");
        });

        test("unknown mode — exits 2, structured envelope on stdout", async () => {
            const { deps, outLines } = makeMockDeps();
            const code = await new PrReviewThreadsScript(deps).run(["bun", "pr-review-threads.ts", "review"]);
            expect(code).toBe(2);
            const out = getStdoutJson(outLines) as Record<string, unknown>;
            expect(out.status).toBe("error");
            expect(out).not.toHaveProperty("pr");
            expect(out).not.toHaveProperty("thread");
        });

        test("unknown option flag — exits 2", async () => {
            const { deps } = makeMockDeps();
            const code = await new PrReviewThreadsScript(deps).run(["bun", "pr-review-threads.ts", "pr", "1", "--unknown"]);
            expect(code).toBe(2);
        });

        test("pr without pr-number — exits 2, structured envelope on stdout", async () => {
            const { deps, outLines } = makeMockDeps();
            const code = await new PrReviewThreadsScript(deps).run(["bun", "pr-review-threads.ts", "pr"]);
            expect(code).toBe(2);
            const out = getStdoutJson(outLines) as Record<string, unknown>;
            expect(out.status).toBe("error");
            expect(out).not.toHaveProperty("pr");
            expect(out).not.toHaveProperty("thread");
        });

        test("pr with non-integer number — exits 2, structured envelope on stdout", async () => {
            const { deps, outLines } = makeMockDeps();
            const code = await new PrReviewThreadsScript(deps).run(["bun", "pr-review-threads.ts", "pr", "abc"]);
            expect(code).toBe(2);
            const out = getStdoutJson(outLines) as Record<string, unknown>;
            expect(out.status).toBe("error");
        });

        test("pr with float number — exits 2", async () => {
            const { deps } = makeMockDeps();
            const code = await new PrReviewThreadsScript(deps).run(["bun", "pr-review-threads.ts", "pr", "1.5"]);
            expect(code).toBe(2);
        });

        test("pr with zero number — exits 2", async () => {
            const { deps } = makeMockDeps();
            const code = await new PrReviewThreadsScript(deps).run(["bun", "pr-review-threads.ts", "pr", "0"]);
            expect(code).toBe(2);
        });

        test("pr with invalid --max-unresolved — exits 2, structured envelope on stdout", async () => {
            const { deps, outLines } = makeMockDeps();
            const code = await new PrReviewThreadsScript(deps).run([
                "bun",
                "pr-review-threads.ts",
                "pr",
                "1",
                "--max-unresolved",
                "abc",
            ]);
            expect(code).toBe(2);
            const out = getStdoutJson(outLines) as Record<string, unknown>;
            expect(out.status).toBe("error");
        });

        test("thread without id — exits 2, structured envelope on stdout", async () => {
            const { deps, outLines } = makeMockDeps();
            const code = await new PrReviewThreadsScript(deps).run(["bun", "pr-review-threads.ts", "thread"]);
            expect(code).toBe(2);
            const out = getStdoutJson(outLines) as Record<string, unknown>;
            expect(out.status).toBe("error");
            expect(out).not.toHaveProperty("pr");
            expect(out).not.toHaveProperty("thread");
        });

        test("thread with --include-resolved — exits 2, structured envelope on stdout", async () => {
            const { deps, outLines } = makeMockDeps();
            const code = await new PrReviewThreadsScript(deps).run([
                "bun",
                "pr-review-threads.ts",
                "thread",
                "PRRT_x",
                "--include-resolved",
            ]);
            expect(code).toBe(2);
            const out = getStdoutJson(outLines) as Record<string, unknown>;
            expect(out.status).toBe("error");
        });

        test("thread with --max-unresolved — exits 2, structured envelope on stdout", async () => {
            const { deps, outLines } = makeMockDeps();
            const code = await new PrReviewThreadsScript(deps).run([
                "bun",
                "pr-review-threads.ts",
                "thread",
                "PRRT_x",
                "--max-unresolved",
                "5",
            ]);
            expect(code).toBe(2);
            const out = getStdoutJson(outLines) as Record<string, unknown>;
            expect(out.status).toBe("error");
        });
    });

    // ---------------------------------------------------------------
    // Environment
    // ---------------------------------------------------------------
    describe("environment", () => {
        test("pr mode: missing GITHUB_OWNER — exits 1, missing_env envelope on stdout", async () => {
            const { deps, outLines } = makeMockDeps({ envVars: { GITHUB_REPO: "repo" } });
            const code = await new PrReviewThreadsScript(deps).run(["bun", "pr-review-threads.ts", "pr", "1"]);
            expect(code).toBe(1);
            const out = getStdoutJson(outLines) as Record<string, unknown>;
            expect(out.status).toBe("error");
            expect((out["pr"] as Record<string, unknown>)?.reason).toBe("missing_env");
            expect(out.error).toBeString();
            expect(out.error as string).toContain("GITHUB_OWNER");
        });

        test("pr mode: missing GITHUB_REPO — exits 1, missing_env envelope on stdout", async () => {
            const { deps, outLines } = makeMockDeps({ envVars: { GITHUB_OWNER: "owner" } });
            const code = await new PrReviewThreadsScript(deps).run(["bun", "pr-review-threads.ts", "pr", "1"]);
            expect(code).toBe(1);
            const out = getStdoutJson(outLines) as Record<string, unknown>;
            expect(out.status).toBe("error");
            expect((out["pr"] as Record<string, unknown>)?.reason).toBe("missing_env");
            expect(out.error).toBeString();
            expect(out.error as string).toContain("GITHUB_REPO");
        });

        test("thread mode: works without GITHUB_OWNER/GITHUB_REPO", async () => {
            const { deps } = makeMockDeps({
                envVars: {},
                runQueue: [makeShellResult(makeThreadNodeResponse())],
            });
            const code = await new PrReviewThreadsScript(deps).run(["bun", "pr-review-threads.ts", "thread", "PRRT_x"]);
            expect(code).toBe(0);
        });

        test("valid ADDA_DEV_PR_REVIEW_SCAN_CEILING override — used as ceiling", async () => {
            const { deps, outLines } = makeMockDeps({
                envVars: { GITHUB_OWNER: "o", GITHUB_REPO: "r", ADDA_DEV_PR_REVIEW_SCAN_CEILING: "2" },
                runQueue: [makeShellResult(makePrThreadsResponse([], 10, false))],
            });
            const code = await new PrReviewThreadsScript(deps).run(["bun", "pr-review-threads.ts", "pr", "1"]);
            expect(code).toBe(1);
            const out = getStdoutJson(outLines) as { pr?: { reason: string } };
            expect(out.pr?.reason).toBe("scan_limit_exceeded");
        });

        test("invalid ADDA_DEV_PR_REVIEW_SCAN_CEILING — exits 2, invalid_config envelope on stdout", async () => {
            const { deps, outLines } = makeMockDeps({
                envVars: { GITHUB_OWNER: "o", GITHUB_REPO: "r", ADDA_DEV_PR_REVIEW_SCAN_CEILING: "abc" },
            });
            const code = await new PrReviewThreadsScript(deps).run(["bun", "pr-review-threads.ts", "pr", "1"]);
            expect(code).toBe(2);
            const out = getStdoutJson(outLines) as Record<string, unknown>;
            expect(out.status).toBe("error");
            expect((out["pr"] as Record<string, unknown>)?.reason).toBe("invalid_config");
        });

        test("ADDA_DEV_PR_REVIEW_SCAN_CEILING=0 — exits 2, invalid_config envelope on stdout", async () => {
            const { deps, outLines } = makeMockDeps({
                envVars: { GITHUB_OWNER: "o", GITHUB_REPO: "r", ADDA_DEV_PR_REVIEW_SCAN_CEILING: "0" },
            });
            const code = await new PrReviewThreadsScript(deps).run(["bun", "pr-review-threads.ts", "pr", "1"]);
            expect(code).toBe(2);
            const out = getStdoutJson(outLines) as Record<string, unknown>;
            expect(out.status).toBe("error");
            expect((out["pr"] as Record<string, unknown>)?.reason).toBe("invalid_config");
        });

        test("thread mode: invalid ceiling — exits 2, invalid_config envelope on stdout", async () => {
            const { deps, outLines } = makeMockDeps({
                envVars: { ADDA_DEV_PR_REVIEW_SCAN_CEILING: "bad" },
                runQueue: [],
            });
            const code = await new PrReviewThreadsScript(deps).run(["bun", "pr-review-threads.ts", "thread", "PRRT_x"]);
            expect(code).toBe(2);
            const out = getStdoutJson(outLines) as Record<string, unknown>;
            expect(out.status).toBe("error");
            expect((out["thread"] as Record<string, unknown>)?.reason).toBe("invalid_config");
        });
    });

    // ---------------------------------------------------------------
    // pr mode: graphql failure
    // ---------------------------------------------------------------
    describe("pr mode: graphql failure", () => {
        test("graphql returns non-zero exit — exits 1, graphql_error envelope on stdout, no file", async () => {
            const { deps, outLines, renamedFiles } = makeMockDeps({
                runQueue: [makeShellResult("", 1, "Could not resolve to a PullRequest with the number of 999999")],
            });
            const code = await new PrReviewThreadsScript(deps).run(["bun", "pr-review-threads.ts", "pr", "999999"]);
            expect(code).toBe(1);
            expect(renamedFiles).toHaveLength(0);
            const out = getStdoutJson(outLines) as Record<string, unknown>;
            expect(out.status).toBe("error");
            const pr = out["pr"] as Record<string, unknown>;
            expect(pr?.reason).toBe("graphql_error");
        });

        test("graphql failure on pagination page — exits 1, graphql_error envelope on stdout", async () => {
            const page1 = makePrThreadsResponse([makeThread()], 2, true, "cursor1");
            const { deps, outLines, renamedFiles } = makeMockDeps({
                runQueue: [makeShellResult(page1), makeShellResult("", 1, "GraphQL error on page 2")],
            });
            const code = await new PrReviewThreadsScript(deps).run(["bun", "pr-review-threads.ts", "pr", "1"]);
            expect(code).toBe(1);
            expect(renamedFiles).toHaveLength(0);
            const out = getStdoutJson(outLines) as Record<string, unknown>;
            expect(out.status).toBe("error");
            expect((out["pr"] as Record<string, unknown>)?.reason).toBe("graphql_error");
        });
    });

    // ---------------------------------------------------------------
    // thread mode: graphql failure
    // ---------------------------------------------------------------
    describe("thread mode: graphql failure", () => {
        test("graphql returns non-zero exit — exits 1, graphql_error envelope on stdout, no file", async () => {
            const { deps, outLines, renamedFiles } = makeMockDeps({
                envVars: {},
                runQueue: [makeShellResult("", 1, "Could not resolve to a node")],
            });
            const code = await new PrReviewThreadsScript(deps).run(["bun", "pr-review-threads.ts", "thread", "PRRT_x"]);
            expect(code).toBe(1);
            expect(renamedFiles).toHaveLength(0);
            const out = getStdoutJson(outLines) as Record<string, unknown>;
            expect(out.status).toBe("error");
            expect((out["thread"] as Record<string, unknown>)?.reason).toBe("graphql_error");
        });
    });

    // ---------------------------------------------------------------
    // pr mode: basic success
    // ---------------------------------------------------------------
    describe("pr mode: basic success", () => {
        test("empty PR — exit 0, file written, empty threads array", async () => {
            const { deps, outLines, renamedFiles } = makeMockDeps({
                runQueue: [makeShellResult(makePrThreadsResponse([]))],
            });
            const code = await new PrReviewThreadsScript(deps).run(["bun", "pr-review-threads.ts", "pr", "303"]);
            expect(code).toBe(0);
            const out = getStdoutJson(outLines) as {
                status: string;
                pr: { number: number; total: number; unresolved: number; returnedUnresolved: number; resultsFile: string };
            };
            expect(out.status).toBe("success");
            expect(out.pr.number).toBe(303);
            expect(out.pr.total).toBe(0);
            expect(out.pr.unresolved).toBe(0);
            expect(out.pr.returnedUnresolved).toBe(0);
            expect(renamedFiles).toHaveLength(1);
            expect(renamedFiles[0]!.to).toMatch(/\/tmp\/pr-review-threads-pr-303-\d+\.json$/);
        });

        test("single unresolved thread — included in output", async () => {
            const thread = makeThread({ id: "PRRT_aaa", isResolved: false });
            const { deps, outLines, renamedFiles } = makeMockDeps({
                runQueue: [makeShellResult(makePrThreadsResponse([thread]))],
            });
            const code = await new PrReviewThreadsScript(deps).run(["bun", "pr-review-threads.ts", "pr", "1"]);
            expect(code).toBe(0);
            const out = getStdoutJson(outLines) as {
                pr: { unresolved: number; resolved: number; returnedUnresolved: number; moreUnresolvedAvailable: boolean };
            };
            expect(out.pr.unresolved).toBe(1);
            expect(out.pr.resolved).toBe(0);
            expect(out.pr.returnedUnresolved).toBe(1);
            expect(out.pr.moreUnresolvedAvailable).toBe(false);
            expect(renamedFiles).toHaveLength(1);
        });

        test("all resolved, no --include-resolved — threads empty, exit 0, file written", async () => {
            const thread = makeThread({ id: "PRRT_bbb", isResolved: true });
            const { deps, outLines, renamedFiles } = makeMockDeps({
                runQueue: [makeShellResult(makePrThreadsResponse([thread]))],
            });
            const code = await new PrReviewThreadsScript(deps).run(["bun", "pr-review-threads.ts", "pr", "1"]);
            expect(code).toBe(0);
            const out = getStdoutJson(outLines) as { pr: { unresolved: number; resolved: number } };
            expect(out.pr.unresolved).toBe(0);
            expect(out.pr.resolved).toBe(1);
            expect(renamedFiles).toHaveLength(1);
        });

        test("--include-resolved adds resolved threads", async () => {
            const t1 = makeThread({ id: "PRRT_r1", isResolved: true });
            const t2 = makeThread({ id: "PRRT_u1", isResolved: false });
            const { deps, renamedFiles, writtenFiles } = makeMockDeps({
                runQueue: [makeShellResult(makePrThreadsResponse([t1, t2]))],
            });
            const code = await new PrReviewThreadsScript(deps).run([
                "bun",
                "pr-review-threads.ts",
                "pr",
                "1",
                "--include-resolved",
            ]);
            expect(code).toBe(0);
            expect(renamedFiles).toHaveLength(1);
            const fileContent = JSON.parse(writtenFiles.values().next().value!) as { threads: Array<{ id: string }> };
            const ids = fileContent.threads.map((t) => t.id);
            expect(ids).toContain("PRRT_r1");
            expect(ids).toContain("PRRT_u1");
        });
    });

    // ---------------------------------------------------------------
    // pr mode: windowing
    // ---------------------------------------------------------------
    describe("pr mode: windowing", () => {
        test("unresolved > maxUnresolved — windowed, moreUnresolvedAvailable true", async () => {
            const threads = Array.from({ length: 10 }, (_, i) => makeThread({ id: `PRRT_${i}`, isResolved: false }));
            const { deps, outLines } = makeMockDeps({
                runQueue: [makeShellResult(makePrThreadsResponse(threads))],
            });
            const code = await new PrReviewThreadsScript(deps).run([
                "bun",
                "pr-review-threads.ts",
                "pr",
                "1",
                "--max-unresolved",
                "3",
            ]);
            expect(code).toBe(0);
            const out = getStdoutJson(outLines) as {
                pr: { unresolved: number; returnedUnresolved: number; moreUnresolvedAvailable: boolean; maxUnresolved: number };
            };
            expect(out.pr.unresolved).toBe(10);
            expect(out.pr.returnedUnresolved).toBe(3);
            expect(out.pr.moreUnresolvedAvailable).toBe(true);
            expect(out.pr.maxUnresolved).toBe(3);
        });

        test("unresolved <= maxUnresolved — all included, moreUnresolvedAvailable false", async () => {
            const threads = Array.from({ length: 3 }, (_, i) => makeThread({ id: `PRRT_${i}`, isResolved: false }));
            const { deps, outLines } = makeMockDeps({
                runQueue: [makeShellResult(makePrThreadsResponse(threads))],
            });
            const code = await new PrReviewThreadsScript(deps).run([
                "bun",
                "pr-review-threads.ts",
                "pr",
                "1",
                "--max-unresolved",
                "5",
            ]);
            expect(code).toBe(0);
            const out = getStdoutJson(outLines) as { pr: { returnedUnresolved: number; moreUnresolvedAvailable: boolean } };
            expect(out.pr.returnedUnresolved).toBe(3);
            expect(out.pr.moreUnresolvedAvailable).toBe(false);
        });

        test("default maxUnresolved is 50", async () => {
            const threads = Array.from({ length: 3 }, (_, i) => makeThread({ id: `PRRT_${i}`, isResolved: false }));
            const { deps, outLines } = makeMockDeps({
                runQueue: [makeShellResult(makePrThreadsResponse(threads))],
            });
            const code = await new PrReviewThreadsScript(deps).run(["bun", "pr-review-threads.ts", "pr", "1"]);
            expect(code).toBe(0);
            const out = getStdoutJson(outLines) as { pr: { maxUnresolved: number } };
            expect(out.pr.maxUnresolved).toBe(50);
        });
    });

    // ---------------------------------------------------------------
    // pr mode: multi-page pagination
    // ---------------------------------------------------------------
    describe("pr mode: multi-page pagination", () => {
        test("two pages of threads — all collected", async () => {
            const page1 = makePrThreadsResponse(
                [makeThread({ id: "PRRT_p1t1" }), makeThread({ id: "PRRT_p1t2" })],
                3,
                true,
                "cursor1",
            );
            const page2 = makePrThreadsResponse([makeThread({ id: "PRRT_p2t1" })], 3, false);
            const { deps, writtenFiles, renamedFiles } = makeMockDeps({
                runQueue: [makeShellResult(page1), makeShellResult(page2)],
            });
            const code = await new PrReviewThreadsScript(deps).run(["bun", "pr-review-threads.ts", "pr", "1"]);
            expect(code).toBe(0);
            expect(renamedFiles).toHaveLength(1);
            const content = JSON.parse(writtenFiles.values().next().value!) as { threads: Array<{ id: string }> };
            expect(content.threads).toHaveLength(3);
            const ids = content.threads.map((t) => t.id);
            expect(ids).toContain("PRRT_p1t1");
            expect(ids).toContain("PRRT_p1t2");
            expect(ids).toContain("PRRT_p2t1");
        });
    });

    // ---------------------------------------------------------------
    // pr mode: comment preview truncation
    // ---------------------------------------------------------------
    describe("pr mode: comment preview truncation", () => {
        test("thread with totalCount > 5 — commentsTruncated true, commentCount set, stderr warning", async () => {
            const comments = Array.from({ length: 5 }, (_, i) => makeComment({ body: `comment ${i}` }));
            const thread = makeThread({ id: "PRRT_trunc", comments, commentsTotalCount: 8 });
            const { deps, errLines, writtenFiles } = makeMockDeps({
                runQueue: [makeShellResult(makePrThreadsResponse([thread]))],
            });
            const code = await new PrReviewThreadsScript(deps).run(["bun", "pr-review-threads.ts", "pr", "1"]);
            expect(code).toBe(0);
            expect(errLines.join("")).toContain("Warning:");
            expect(errLines.join("")).toContain("PRRT_trunc");
            const content = JSON.parse(writtenFiles.values().next().value!) as {
                threads: Array<{ commentsTruncated?: boolean; commentCount?: number; comments: unknown[] }>;
            };
            const t = content.threads[0]!;
            expect(t.commentsTruncated).toBe(true);
            expect(t.commentCount).toBe(8);
            expect(t.comments).toHaveLength(5);
        });

        test("thread with totalCount <= 5 — no truncation fields, no warning", async () => {
            const thread = makeThread({ id: "PRRT_ok", commentsTotalCount: 2 });
            const { deps, errLines, writtenFiles } = makeMockDeps({
                runQueue: [makeShellResult(makePrThreadsResponse([thread]))],
            });
            const code = await new PrReviewThreadsScript(deps).run(["bun", "pr-review-threads.ts", "pr", "1"]);
            expect(code).toBe(0);
            expect(errLines.join("")).toBe("");
            const content = JSON.parse(writtenFiles.values().next().value!) as {
                threads: Array<{ commentsTruncated?: boolean; commentCount?: number }>;
            };
            const t = content.threads[0]!;
            expect(t.commentsTruncated).toBeUndefined();
            expect(t.commentCount).toBeUndefined();
        });

        test("thread with hasNextPage true — commentsTruncated true even if totalCount <= 5", async () => {
            const thread = makeThread({ id: "PRRT_np", commentsTotalCount: 3, commentsHasNextPage: true });
            const { deps, writtenFiles } = makeMockDeps({
                runQueue: [makeShellResult(makePrThreadsResponse([thread]))],
            });
            const code = await new PrReviewThreadsScript(deps).run(["bun", "pr-review-threads.ts", "pr", "1"]);
            expect(code).toBe(0);
            const content = JSON.parse(writtenFiles.values().next().value!) as {
                threads: Array<{ commentsTruncated?: boolean }>;
            };
            expect(content.threads[0]!.commentsTruncated).toBe(true);
        });
    });

    // ---------------------------------------------------------------
    // pr mode: scan ceiling
    // ---------------------------------------------------------------
    describe("pr mode: scan ceiling", () => {
        test("threads totalCount > ceiling — scan_limit_exceeded, no file, exits 1", async () => {
            const { deps, outLines, renamedFiles } = makeMockDeps({
                envVars: { GITHUB_OWNER: "o", GITHUB_REPO: "r", ADDA_DEV_PR_REVIEW_SCAN_CEILING: "5" },
                runQueue: [makeShellResult(makePrThreadsResponse([], 10, false))],
            });
            const code = await new PrReviewThreadsScript(deps).run(["bun", "pr-review-threads.ts", "pr", "1"]);
            expect(code).toBe(1);
            expect(renamedFiles).toHaveLength(0);
            const out = getStdoutJson(outLines) as {
                status: string;
                pr?: { reason: string; total?: number; ceiling?: number };
            };
            expect(out.status).toBe("error");
            expect(out.pr?.reason).toBe("scan_limit_exceeded");
            expect(out.pr?.total).toBe(10);
            expect(out.pr?.ceiling).toBe(5);
        });

        test("threads totalCount <= ceiling — succeeds", async () => {
            const { deps } = makeMockDeps({
                envVars: { GITHUB_OWNER: "o", GITHUB_REPO: "r", ADDA_DEV_PR_REVIEW_SCAN_CEILING: "10" },
                runQueue: [makeShellResult(makePrThreadsResponse([], 10, false))],
            });
            const code = await new PrReviewThreadsScript(deps).run(["bun", "pr-review-threads.ts", "pr", "1"]);
            expect(code).toBe(0);
        });
    });

    // ---------------------------------------------------------------
    // pr mode: domain nulls
    // ---------------------------------------------------------------
    describe("pr mode: domain nulls", () => {
        test("repository not found — exits 1, no file, repo_not_found reason", async () => {
            const { deps, outLines, renamedFiles } = makeMockDeps({
                runQueue: [makeShellResult(makeRepoNotFound())],
            });
            const code = await new PrReviewThreadsScript(deps).run(["bun", "pr-review-threads.ts", "pr", "1"]);
            expect(code).toBe(1);
            expect(renamedFiles).toHaveLength(0);
            const out = getStdoutJson(outLines) as Record<string, unknown>;
            expect(out.status).toBe("error");
            expect((out["pr"] as Record<string, unknown>)?.reason).toBe("repo_not_found");
        });

        test("PR not found — exits 1, no file, pr_not_found reason", async () => {
            const { deps, outLines, renamedFiles } = makeMockDeps({
                runQueue: [makeShellResult(makePrNotFound())],
            });
            const code = await new PrReviewThreadsScript(deps).run(["bun", "pr-review-threads.ts", "pr", "1"]);
            expect(code).toBe(1);
            expect(renamedFiles).toHaveLength(0);
            const out = getStdoutJson(outLines) as Record<string, unknown>;
            expect(out.status).toBe("error");
            expect((out["pr"] as Record<string, unknown>)?.reason).toBe("pr_not_found");
        });
    });

    // ---------------------------------------------------------------
    // pr mode: file invariant
    // ---------------------------------------------------------------
    describe("pr mode: file invariant", () => {
        test("success — writeFile and renameFile called with correct pattern", async () => {
            const { deps, renamedFiles, writtenFiles } = makeMockDeps({
                runQueue: [makeShellResult(makePrThreadsResponse([]))],
            });
            const code = await new PrReviewThreadsScript(deps).run(["bun", "pr-review-threads.ts", "pr", "42"]);
            expect(code).toBe(0);
            expect(renamedFiles).toHaveLength(1);
            expect(renamedFiles[0]!.to).toMatch(/\/tmp\/pr-review-threads-pr-42-\d+\.json$/);
            expect(writtenFiles.size).toBe(1);
        });

        test("error — no renameFile called", async () => {
            const { deps, renamedFiles } = makeMockDeps({
                runQueue: [makeShellResult(makeRepoNotFound())],
            });
            const code = await new PrReviewThreadsScript(deps).run(["bun", "pr-review-threads.ts", "pr", "1"]);
            expect(code).toBe(1);
            expect(renamedFiles).toHaveLength(0);
        });
    });

    // ---------------------------------------------------------------
    // pr mode: hunk fields
    // ---------------------------------------------------------------
    describe("pr mode: hunk fields", () => {
        test("targetLine is last line of hunk, hunkPreview omits @@ header, hunks map contains full hunk", async () => {
            const hunk = "@@ -1,4 +1,5 @@\n line1\n line2\n-removed\n+added\n+added2";
            const thread = makeThread({ id: "PRRT_hunk", comments: [makeComment({ diffHunk: hunk })] });
            const { deps, writtenFiles } = makeMockDeps({
                runQueue: [makeShellResult(makePrThreadsResponse([thread]))],
            });
            const code = await new PrReviewThreadsScript(deps).run(["bun", "pr-review-threads.ts", "pr", "1"]);
            expect(code).toBe(0);
            const content = JSON.parse(writtenFiles.values().next().value!) as {
                threads: Array<{ targetLine: string; hunkPreview: string }>;
                hunks: Record<string, string>;
            };
            const t = content.threads[0]!;
            expect(t.targetLine).toBe("+added2");
            expect(t.hunkPreview).not.toContain("@@");
            expect(t.hunkPreview).toContain("+added2");
            expect(content.hunks["PRRT_hunk"]).toBe(hunk);
        });

        test("null hunk (thread with no comments) — targetLine and hunkPreview are null", async () => {
            const thread = makeThread({ id: "PRRT_nohunk", comments: [] });
            const { deps, writtenFiles } = makeMockDeps({
                runQueue: [makeShellResult(makePrThreadsResponse([thread]))],
            });
            const code = await new PrReviewThreadsScript(deps).run(["bun", "pr-review-threads.ts", "pr", "1"]);
            expect(code).toBe(0);
            const content = JSON.parse(writtenFiles.values().next().value!) as {
                threads: Array<{ targetLine: null; hunkPreview: null }>;
            };
            expect(content.threads[0]!.targetLine).toBeNull();
            expect(content.threads[0]!.hunkPreview).toBeNull();
        });
    });

    // ---------------------------------------------------------------
    // pr mode: envelope shape
    // ---------------------------------------------------------------
    describe("pr mode: envelope shape", () => {
        test("success envelope has mode-keyed pr payload with resultsFile, no result wrapper", async () => {
            const { deps, outLines } = makeMockDeps({
                runQueue: [makeShellResult(makePrThreadsResponse([]))],
            });
            const code = await new PrReviewThreadsScript(deps).run(["bun", "pr-review-threads.ts", "pr", "303"]);
            expect(code).toBe(0);
            const out = getStdoutJson(outLines) as Record<string, unknown>;
            expect(out).toHaveProperty("status");
            expect(out).toHaveProperty("error");
            expect(out).toHaveProperty("pr");
            expect(out).not.toHaveProperty("result");
            expect(out).not.toHaveProperty("mode");
            const pr = out["pr"] as Record<string, unknown>;
            expect(pr).toHaveProperty("resultsFile");
            expect(pr).toHaveProperty("number", 303);
        });

        test("error envelope has pr key with reason", async () => {
            const { deps, outLines } = makeMockDeps({
                runQueue: [makeShellResult(makeRepoNotFound())],
            });
            await new PrReviewThreadsScript(deps).run(["bun", "pr-review-threads.ts", "pr", "1"]);
            const out = getStdoutJson(outLines) as Record<string, unknown>;
            expect(out).toHaveProperty("status", "error");
            expect(out).toHaveProperty("pr");
            const pr = out["pr"] as Record<string, unknown>;
            expect(pr).toHaveProperty("reason");
        });

        test("pre-dispatch error emits structured envelope on stdout (no pr/thread key)", async () => {
            const { deps, outLines } = makeMockDeps();
            await new PrReviewThreadsScript(deps).run(["bun", "pr-review-threads.ts"]);
            const out = getStdoutJson(outLines) as Record<string, unknown>;
            expect(out.status).toBe("error");
            expect(out).toHaveProperty("error");
            expect(out).not.toHaveProperty("pr");
            expect(out).not.toHaveProperty("thread");
        });
    });

    // ---------------------------------------------------------------
    // thread mode: basic success
    // ---------------------------------------------------------------
    describe("thread mode: basic success", () => {
        test("success — exit 0, file written, pr derived from node.pullRequest.number", async () => {
            const { deps, outLines, renamedFiles } = makeMockDeps({
                envVars: {},
                runQueue: [makeShellResult(makeThreadNodeResponse({ id: "PRRT_abc", prNumber: 303 }))],
            });
            const code = await new PrReviewThreadsScript(deps).run(["bun", "pr-review-threads.ts", "thread", "PRRT_abc"]);
            expect(code).toBe(0);
            const out = getStdoutJson(outLines) as { status: string; thread: { id: string; pr: number; resultsFile: string } };
            expect(out.status).toBe("success");
            expect(out.thread.id).toBe("PRRT_abc");
            expect(out.thread.pr).toBe(303);
            expect(renamedFiles).toHaveLength(1);
            expect(renamedFiles[0]!.to).toMatch(/\/tmp\/pr-review-threads-thread-\d+\.json$/);
        });

        test("file header matches envelope minus resultsFile", async () => {
            const { deps, outLines, writtenFiles } = makeMockDeps({
                envVars: {},
                runQueue: [
                    makeShellResult(
                        makeThreadNodeResponse({
                            id: "PRRT_abc",
                            prNumber: 303,
                            isResolved: true,
                            isOutdated: false,
                        }),
                    ),
                ],
            });
            const code = await new PrReviewThreadsScript(deps).run(["bun", "pr-review-threads.ts", "thread", "PRRT_abc"]);
            expect(code).toBe(0);
            const envOut = getStdoutJson(outLines) as { thread: Record<string, unknown> };
            const fileContent = JSON.parse(writtenFiles.values().next().value!) as {
                thread: Record<string, unknown>;
                threads: unknown[];
                hunks: Record<string, string>;
            };
            // File header = envelope minus resultsFile
            const { resultsFile: _, ...headerWithoutFile } = envOut.thread;
            expect(fileContent.thread).toEqual(headerWithoutFile);
            expect(fileContent.threads).toHaveLength(1);
        });
    });

    // ---------------------------------------------------------------
    // thread mode: pagination
    // ---------------------------------------------------------------
    describe("thread mode: pagination", () => {
        test("two pages of comments — all collected", async () => {
            const page1 = makeThreadNodeResponse({
                id: "PRRT_pg",
                commentsTotalCount: 3,
                commentsHasNextPage: true,
                endCursor: "c1",
                comments: [makeComment({ body: "c1" }), makeComment({ body: "c2" })],
            });
            const page2 = makeThreadNodeResponse({
                id: "PRRT_pg",
                commentsTotalCount: 3,
                commentsHasNextPage: false,
                comments: [makeComment({ body: "c3" })],
            });
            const { deps, writtenFiles } = makeMockDeps({
                envVars: {},
                runQueue: [makeShellResult(page1), makeShellResult(page2)],
            });
            const code = await new PrReviewThreadsScript(deps).run(["bun", "pr-review-threads.ts", "thread", "PRRT_pg"]);
            expect(code).toBe(0);
            const content = JSON.parse(writtenFiles.values().next().value!) as {
                threads: Array<{ comments: Array<{ body: string }> }>;
            };
            const comments = content.threads[0]!.comments;
            expect(comments).toHaveLength(3);
            expect(comments.map((c) => c.body)).toEqual(["c1", "c2", "c3"]);
        });
    });

    // ---------------------------------------------------------------
    // thread mode: ceiling
    // ---------------------------------------------------------------
    describe("thread mode: ceiling", () => {
        test("comments totalCount > ceiling — refuses, no file, exits 1", async () => {
            const { deps, outLines, renamedFiles } = makeMockDeps({
                envVars: { ADDA_DEV_PR_REVIEW_SCAN_CEILING: "3" },
                runQueue: [makeShellResult(makeThreadNodeResponse({ commentsTotalCount: 10 }))],
            });
            const code = await new PrReviewThreadsScript(deps).run(["bun", "pr-review-threads.ts", "thread", "PRRT_x"]);
            expect(code).toBe(1);
            expect(renamedFiles).toHaveLength(0);
            const out = getStdoutJson(outLines) as { status: string; thread?: { reason: string; commentCount?: number } };
            expect(out.status).toBe("error");
            expect(out.thread?.reason).toBe("scan_limit_exceeded");
            expect(out.thread?.commentCount).toBe(10);
        });
    });

    // ---------------------------------------------------------------
    // thread mode: domain errors
    // ---------------------------------------------------------------
    describe("thread mode: domain errors", () => {
        test("node not found (null) — exits 1, no file, thread_not_found reason", async () => {
            const { deps, outLines, renamedFiles } = makeMockDeps({
                envVars: {},
                runQueue: [makeShellResult(makeThreadNodeNotFound())],
            });
            const code = await new PrReviewThreadsScript(deps).run(["bun", "pr-review-threads.ts", "thread", "PRRT_x"]);
            expect(code).toBe(1);
            expect(renamedFiles).toHaveLength(0);
            const out = getStdoutJson(outLines) as Record<string, unknown>;
            expect(out.status).toBe("error");
            expect((out["thread"] as Record<string, unknown>)?.reason).toBe("thread_not_found");
        });

        test("node is not a PullRequestReviewThread — exits 1, no file, not_a_thread reason", async () => {
            const { deps, outLines, renamedFiles } = makeMockDeps({
                envVars: {},
                runQueue: [makeShellResult(makeThreadNodeResponse({ typename: "Issue" }))],
            });
            const code = await new PrReviewThreadsScript(deps).run(["bun", "pr-review-threads.ts", "thread", "PRRT_x"]);
            expect(code).toBe(1);
            expect(renamedFiles).toHaveLength(0);
            const out = getStdoutJson(outLines) as Record<string, unknown>;
            expect(out.status).toBe("error");
            expect((out["thread"] as Record<string, unknown>)?.reason).toBe("not_a_thread");
        });
    });

    // ---------------------------------------------------------------
    // thread mode: envelope shape
    // ---------------------------------------------------------------
    describe("thread mode: envelope shape", () => {
        test("success envelope has thread key, no pr key, no result wrapper", async () => {
            const { deps, outLines } = makeMockDeps({
                envVars: {},
                runQueue: [makeShellResult(makeThreadNodeResponse())],
            });
            const code = await new PrReviewThreadsScript(deps).run(["bun", "pr-review-threads.ts", "thread", "PRRT_x"]);
            expect(code).toBe(0);
            const out = getStdoutJson(outLines) as Record<string, unknown>;
            expect(out).toHaveProperty("thread");
            expect(out).not.toHaveProperty("pr");
            expect(out).not.toHaveProperty("result");
            expect(out).not.toHaveProperty("mode");
        });
    });

    // ---------------------------------------------------------------
    // double-emit guard: existing envelope is not overwritten by catch
    // ---------------------------------------------------------------
    describe("double-emit guard", () => {
        test("explicit emitModeError is not overwritten by catch-all — single envelope on stdout", async () => {
            const { deps, outLines } = makeMockDeps({
                runQueue: [makeShellResult(makeRepoNotFound())],
            });
            await new PrReviewThreadsScript(deps).run(["bun", "pr-review-threads.ts", "pr", "1"]);
            // Exactly one JSON object should be written; joining and parsing must not throw
            const combined = outLines.join("").trim();
            expect(() => JSON.parse(combined)).not.toThrow();
            const out = JSON.parse(combined) as Record<string, unknown>;
            expect(out.status).toBe("error");
            expect((out["pr"] as Record<string, unknown>)?.reason).toBe("repo_not_found");
        });

        test("pr graphql error — single envelope on stdout", async () => {
            const { deps, outLines } = makeMockDeps({
                runQueue: [makeShellResult("", 1, "GraphQL failed")],
            });
            await new PrReviewThreadsScript(deps).run(["bun", "pr-review-threads.ts", "pr", "1"]);
            const combined = outLines.join("").trim();
            expect(() => JSON.parse(combined)).not.toThrow();
            const out = JSON.parse(combined) as Record<string, unknown>;
            expect(out.status).toBe("error");
        });
    });
});

// ---------------------------------------------------------------
// Pure helper unit tests
// ---------------------------------------------------------------
import { buildHunkPreview, extractTargetLine, sortThreads, toThreadObject } from "./pr-review-threads/helpers";
import type { ThreadNode } from "./pr-review-threads/graphql";

describe("extractTargetLine", () => {
    test("returns last non-empty line of hunk", () => {
        const hunk = "@@ -1,3 +1,4 @@\n line1\n-old\n+new";
        expect(extractTargetLine(hunk)).toBe("+new");
    });

    test("ignores trailing empty lines", () => {
        const hunk = "@@ -1,3 +1,4 @@\n line1\n+new\n";
        expect(extractTargetLine(hunk)).toBe("+new");
    });

    test("returns null for null input", () => {
        expect(extractTargetLine(null)).toBeNull();
    });

    test("returns null for empty string", () => {
        expect(extractTargetLine("")).toBeNull();
    });
});

describe("buildHunkPreview", () => {
    test("drops @@ header and returns body", () => {
        const hunk = "@@ -1,3 +1,3 @@\n line1\n-old\n+new";
        const preview = buildHunkPreview(hunk);
        expect(preview).not.toContain("@@");
        expect(preview).toContain("+new");
        expect(preview).toContain(" line1");
    });

    test("body longer than tail — prefixed with '…' and clipped", () => {
        const lines = ["@@ -1,10 +1,10 @@", " a", " b", " c", " d", " e", " f", " g", " h", " i", " j"];
        const hunk = lines.join("\n");
        const preview = buildHunkPreview(hunk, 3);
        expect(preview).toMatch(/^…/);
        expect(preview).toContain(" h\n i\n j");
    });

    test("body shorter than tail — no ellipsis prefix", () => {
        const hunk = "@@ -1,2 +1,2 @@\n line1\n+new";
        const preview = buildHunkPreview(hunk, 7);
        expect(preview).not.toContain("…");
    });

    test("returns null for null hunk", () => {
        expect(buildHunkPreview(null)).toBeNull();
    });

    test("returns null when body is empty after removing trailing lines", () => {
        const hunk = "@@ -1,0 +1,0 @@\n";
        expect(buildHunkPreview(hunk)).toBeNull();
    });
});

describe("sortThreads", () => {
    test("sorts by path, then by line", () => {
        const makeNode = (id: string, path: string, line: number | null, originalLine: number | null): ThreadNode => ({
            id,
            isResolved: false,
            isOutdated: false,
            path,
            line,
            startLine: null,
            originalLine,
            diffSide: "RIGHT",
            comments: { totalCount: 1, pageInfo: { hasNextPage: false }, nodes: [] },
        });
        const nodes = [
            makeNode("c", "b.ts", 4, null),
            makeNode("a", "a.ts", 5, null),
            makeNode("b", "a.ts", 1, null),
            makeNode("d", "b.ts", null, 3),
        ];
        const sorted = sortThreads(nodes);
        expect(sorted[0]!.id).toBe("b");
        expect(sorted[1]!.id).toBe("a");
        expect(sorted[2]!.id).toBe("d");
        expect(sorted[3]!.id).toBe("c");
    });
});

describe("toThreadObject", () => {
    test("maps node to thread object shape with correct fields", () => {
        const hunk = "@@ -1,3 +1,3 @@\n line\n-old\n+new";
        const node: ThreadNode = {
            id: "PRRT_x",
            isResolved: false,
            isOutdated: true,
            path: "src/foo.ts",
            line: 5,
            startLine: null,
            originalLine: 3,
            diffSide: "RIGHT",
            comments: {
                totalCount: 1,
                pageInfo: { hasNextPage: false },
                nodes: [
                    {
                        author: { login: "alice" },
                        body: "nice",
                        url: "https://example.com#r1",
                        createdAt: "2026-01-01T00:00:00Z",
                        diffHunk: hunk,
                    },
                ],
            },
        };
        const obj = toThreadObject(node);
        expect(obj.id).toBe("PRRT_x");
        expect(obj.path).toBe("src/foo.ts");
        expect(obj.isOutdated).toBe(true);
        expect(obj.targetLine).toBe("+new");
        expect(obj.hunkPreview).not.toContain("@@");
        expect(obj.comments[0]!.author).toBe("alice");
        expect(obj.commentsTruncated).toBeUndefined();
    });

    test("sets commentsTruncated when totalCount > 5", () => {
        const node: ThreadNode = {
            id: "PRRT_y",
            isResolved: false,
            isOutdated: false,
            path: "f.ts",
            line: 1,
            startLine: null,
            originalLine: 1,
            diffSide: "RIGHT",
            comments: {
                totalCount: 10,
                pageInfo: { hasNextPage: false },
                nodes: [],
            },
        };
        const obj = toThreadObject(node);
        expect(obj.commentsTruncated).toBe(true);
        expect(obj.commentCount).toBe(10);
    });
});
