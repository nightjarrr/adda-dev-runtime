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
            const { deps, outLines, errLines, renamedFiles } = makeMockDeps({
                runQueue: [makeShellResult("", 1, "Could not resolve to a PullRequest with the number of 999999")],
            });
            const code = await new PrReviewThreadsScript(deps).run(["bun", "pr-review-threads.ts", "pr", "999999"]);
            expect(code).toBe(1);
            expect(renamedFiles).toHaveLength(0);
            const out = getStdoutJson(outLines) as Record<string, unknown>;
            expect(out.status).toBe("error");
            const pr = out["pr"] as Record<string, unknown>;
            expect(pr?.reason).toBe("graphql_error");
            // gh's stderr must be forwarded to the script's stderr
            expect(errLines.join("")).toContain("Could not resolve to a PullRequest with the number of 999999");
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
            const { deps, outLines, errLines, renamedFiles } = makeMockDeps({
                envVars: {},
                runQueue: [makeShellResult("", 1, "Could not resolve to a node")],
            });
            const code = await new PrReviewThreadsScript(deps).run(["bun", "pr-review-threads.ts", "thread", "PRRT_x"]);
            expect(code).toBe(1);
            expect(renamedFiles).toHaveLength(0);
            const out = getStdoutJson(outLines) as Record<string, unknown>;
            expect(out.status).toBe("error");
            expect((out["thread"] as Record<string, unknown>)?.reason).toBe("graphql_error");
            // gh's stderr must be forwarded to the script's stderr
            expect(errLines.join("")).toContain("Could not resolve to a node");
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
    // single-envelope invariant: only one JSON object written per invocation
    // ---------------------------------------------------------------
    describe("single-envelope invariant", () => {
        test("repo_not_found — single envelope on stdout", async () => {
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
import { hunkToFields, sortThreads, toThreadObject } from "./pr-review-threads/helpers";
import type { ThreadNode } from "./pr-review-threads/graphql";
import { PrThreadsArgsError, PrThreadsModeError } from "./pr-review-threads/errors";
import { paginate } from "./pr-review-threads/fetch";
import { PR_THREADS_QUERY, PrThreadsPageSchema } from "./pr-review-threads/graphql";
import { ScriptError, ScriptStructuredError, atomicWriteFile } from "../lib/index";

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

// ---------------------------------------------------------------
// hunkToFields unit tests
// ---------------------------------------------------------------

describe("hunkToFields", () => {
    test("returns targetLine and hunkPreview for a normal hunk", () => {
        const hunk = "@@ -1,3 +1,4 @@\n line1\n-old\n+new";
        const { targetLine, hunkPreview } = hunkToFields(hunk);
        expect(targetLine).toBe("+new");
        expect(hunkPreview).not.toContain("@@");
        expect(hunkPreview).toContain("+new");
    });

    test("body within tail — hunkPreview has no ellipsis prefix, contains all body lines", () => {
        const hunk = "@@ -1,2 +1,2 @@\n line1\n+new";
        const { targetLine, hunkPreview } = hunkToFields(hunk, 7);
        expect(targetLine).toBe("+new");
        expect(hunkPreview).not.toContain("…");
        expect(hunkPreview).toContain(" line1");
        expect(hunkPreview).toContain("+new");
    });

    test("body longer than tail — hunkPreview prefixed with '…' and clipped", () => {
        const lines = ["@@ -1,10 +1,10 @@", " a", " b", " c", " d", " e", " f", " g", " h", " i", " j"];
        const hunk = lines.join("\n");
        const { targetLine, hunkPreview } = hunkToFields(hunk, 3);
        expect(targetLine).toBe(" j");
        expect(hunkPreview).toMatch(/^…/);
        expect(hunkPreview).toContain(" h\n i\n j");
    });

    test("header-only hunk (body empty after trailing-line drop) — hunkPreview null, targetLine from header", () => {
        const hunk = "@@ -1,0 +1,0 @@\n";
        const { targetLine, hunkPreview } = hunkToFields(hunk);
        expect(targetLine).toBe("@@ -1,0 +1,0 @@");
        expect(hunkPreview).toBeNull();
    });

    test("returns nulls for null input", () => {
        const { targetLine, hunkPreview } = hunkToFields(null);
        expect(targetLine).toBeNull();
        expect(hunkPreview).toBeNull();
    });

    test("returns nulls for empty string", () => {
        const { targetLine, hunkPreview } = hunkToFields("");
        expect(targetLine).toBeNull();
        expect(hunkPreview).toBeNull();
    });

    test("hunkPreview is null when body is empty after dropping trailing lines", () => {
        const hunk = "@@ -1,0 +1,0 @@\n";
        const { hunkPreview } = hunkToFields(hunk);
        expect(hunkPreview).toBeNull();
    });

    test("hunkPreview is prefixed with '…' when body exceeds tail", () => {
        const lines = ["@@ -1,10 +1,10 @@", " a", " b", " c", " d", " e", " f", " g", " h", " i", " j"];
        const hunk = lines.join("\n");
        const { hunkPreview } = hunkToFields(hunk, 3);
        expect(hunkPreview).toMatch(/^…/);
        expect(hunkPreview).toContain(" h\n i\n j");
    });

    test("targetLine ignores trailing empty lines", () => {
        const hunk = "@@ -1,2 +1,3 @@\n line\n+new\n";
        const { targetLine } = hunkToFields(hunk);
        expect(targetLine).toBe("+new");
    });
});

// ---------------------------------------------------------------
// atomicWriteFile unit tests (lib utility)
// ---------------------------------------------------------------

type AtomicFileDeps = TmpDep & FileWriterDep & FileSysDep;

function makeAtomicFileDeps(): {
    deps: AtomicFileDeps;
    writtenFiles: Map<string, string>;
    renamedFiles: Array<{ from: string; to: string }>;
} {
    const writtenFiles = new Map<string, string>();
    const renamedFiles: Array<{ from: string; to: string }> = [];
    const deps: AtomicFileDeps = {
        tmp: {
            tmpDir: mock(() => "/tmp"),
            tempFilePath: mock((p = "tmp", s = "") => `/tmp/${p}-uuid${s}`),
            makeTempDir: mock(() => "/tmp/dir"),
        },
        fileWriter: {
            writeFile: mock(async (path: string, content: string): Promise<void> => {
                writtenFiles.set(path, content);
            }),
        },
        fileSys: {
            renameFile: mock(async (from: string, to: string): Promise<void> => {
                renamedFiles.push({ from, to });
            }),
            deleteFile: mock(async () => {}),
            fileExists: mock(async () => false),
        },
    };
    return { deps, writtenFiles, renamedFiles };
}

describe("atomicWriteFile", () => {
    test("writes then renames, returns final path", async () => {
        const { deps, writtenFiles, renamedFiles } = makeAtomicFileDeps();
        const path = await atomicWriteFile(deps, "/tmp/pr-review-threads-pr-42-<ts>.json", '{"foo":"bar"}');
        expect(writtenFiles.size).toBe(1);
        expect(renamedFiles).toHaveLength(1);
        expect(path).toMatch(/\/tmp\/pr-review-threads-pr-42-\d+\.json$/);
    });

    test("<tmpDir> placeholder expands to deps.tmp.tmpDir()", async () => {
        const { deps, renamedFiles } = makeAtomicFileDeps();
        const path = await atomicWriteFile(deps, "<tmpDir>/out.json", "data");
        expect(path).toBe("/tmp/out.json");
        expect(renamedFiles[0]!.to).toBe("/tmp/out.json");
    });

    test("content is written as provided", async () => {
        const { deps, writtenFiles } = makeAtomicFileDeps();
        await atomicWriteFile(deps, "/tmp/test.json", '{"key":"value"}');
        const content = writtenFiles.values().next().value!;
        expect(JSON.parse(content)).toEqual({ key: "value" });
    });
});

// ---------------------------------------------------------------
// PrThreadsArgsError unit tests
// ---------------------------------------------------------------

describe("PrThreadsArgsError", () => {
    test("is a ScriptStructuredError with exit code 2", () => {
        const err = new PrThreadsArgsError("mode is required");
        expect(err).toBeInstanceOf(ScriptStructuredError);
        expect(err.exitCode).toBe(2);
    });

    test("envelope has status error and error message", () => {
        const err = new PrThreadsArgsError("invalid argument");
        const envelope = err.envelope as Record<string, unknown>;
        expect(envelope.status).toBe("error");
        expect(envelope.error).toBe("invalid argument");
    });

    test("message matches the provided string", () => {
        const err = new PrThreadsArgsError("pr mode requires a PR number");
        expect(err.message).toBe("pr mode requires a PR number");
    });

    test("name is 'PrThreadsArgsError'", () => {
        const err = new PrThreadsArgsError("bad");
        expect(err.name).toBe("PrThreadsArgsError");
    });
});

// ---------------------------------------------------------------
// PrThreadsModeError unit tests
// ---------------------------------------------------------------

describe("PrThreadsModeError", () => {
    test("is a ScriptStructuredError", () => {
        const err = new PrThreadsModeError("pr", new ScriptError("msg", 1, "reason_code"));
        expect(err).toBeInstanceOf(ScriptStructuredError);
    });

    test("pr mode: envelope has pr key with reason and payload from ScriptError", () => {
        const cause = new ScriptError("repo not found", 1, "repo_not_found", { extra: 42 });
        const err = new PrThreadsModeError("pr", cause);
        const envelope = err.envelope as Record<string, unknown>;
        expect(envelope.status).toBe("error");
        expect(envelope.error).toBe("repo not found");
        const pr = envelope["pr"] as Record<string, unknown>;
        expect(pr?.reason).toBe("repo_not_found");
        expect(pr?.extra).toBe(42);
    });

    test("thread mode: envelope has thread key", () => {
        const cause = new ScriptError("not found", 1, "thread_not_found");
        const err = new PrThreadsModeError("thread", cause);
        const envelope = err.envelope as Record<string, unknown>;
        expect(envelope).toHaveProperty("thread");
        expect((envelope["thread"] as Record<string, unknown>)?.reason).toBe("thread_not_found");
    });

    test("non-ScriptError cause: internal_error reason, exitCode 1", () => {
        const err = new PrThreadsModeError("pr", new Error("boom"));
        expect(err.exitCode).toBe(1);
        const envelope = err.envelope as Record<string, unknown>;
        expect((envelope["pr"] as Record<string, unknown>)?.reason).toBe("internal_error");
    });

    test("inherits exitCode from ScriptError cause", () => {
        const cause = new ScriptError("config bad", 2, "invalid_config");
        const err = new PrThreadsModeError("pr", cause);
        expect(err.exitCode).toBe(2);
    });

    test("threads verboseStderr from ScriptError cause", () => {
        const cause = new ScriptError("failed", 1, "graphql_error", {}, "raw stderr from gh");
        const err = new PrThreadsModeError("pr", cause);
        expect(err.verboseStderr).toBe("raw stderr from gh");
    });

    test("verboseStderr is undefined when cause has no verboseStderr", () => {
        const cause = new ScriptError("failed", 1, "error_code");
        const err = new PrThreadsModeError("pr", cause);
        expect(err.verboseStderr).toBeUndefined();
    });

    test("verboseStderr is undefined for non-ScriptError cause", () => {
        const err = new PrThreadsModeError("pr", new Error("boom"));
        expect(err.verboseStderr).toBeUndefined();
    });
});

// ---------------------------------------------------------------
// paginate unit tests
// ---------------------------------------------------------------

describe("paginate", () => {
    function makeShellDeps(runQueue: Array<{ stdout: string; exitCode?: number; stderr?: string }>): ShellDep & StdioDep {
        const queue = [...runQueue];
        return {
            shell: {
                run: mock(async (_command: string[], opts?: { strict?: boolean }) => {
                    const next = queue.shift() ?? { stdout: "{}", exitCode: 0, stderr: "" };
                    const exitCode = next.exitCode ?? 0;
                    if ((opts?.strict ?? true) && exitCode !== 0) {
                        throw new Error(`shell error (exit ${exitCode})`);
                    }
                    return { stdout: next.stdout, stderr: next.stderr ?? "", exitCode };
                }),
                runSh: mock(async () => ({ stdout: "", stderr: "", exitCode: 0 })),
            },
            stdio: {
                stdin: { text: mock(async () => "") },
                stdout: { write: mock(() => {}) },
                stderr: { write: mock(() => {}) },
            },
        };
    }

    function makeThreadNode(id: string): ThreadNode {
        return {
            id,
            isResolved: false,
            isOutdated: false,
            path: "f.ts",
            line: 1,
            startLine: null,
            originalLine: 1,
            diffSide: "RIGHT",
            comments: { totalCount: 0, pageInfo: { hasNextPage: false }, nodes: [] },
        };
    }

    function makePrPage(ids: string[], hasNextPage: boolean, endCursor: string | null = null): string {
        return JSON.stringify({
            data: {
                repository: {
                    pullRequest: {
                        reviewThreads: {
                            totalCount: ids.length,
                            pageInfo: { hasNextPage, endCursor },
                            nodes: ids.map(makeThreadNode),
                        },
                    },
                },
            },
        });
    }

    function extractPrPage(parsed: {
        data: {
            repository: {
                pullRequest: {
                    reviewThreads: { nodes: ThreadNode[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
                } | null;
            } | null;
        };
    }): { nodes: ThreadNode[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } | null {
        return parsed.data.repository?.pullRequest?.reviewThreads ?? null;
    }

    test("single page — returns first nodes without fetching more", async () => {
        const deps = makeShellDeps([]);
        const firstNodes = [makeThreadNode("PRRT_1")];
        const firstPageInfo = { hasNextPage: false, endCursor: null };
        const result = await paginate(
            deps,
            firstNodes,
            firstPageInfo,
            { owner: "o", repo: "r", number: 1 },
            PR_THREADS_QUERY,
            PrThreadsPageSchema,
            extractPrPage,
            "error",
        );
        expect(result).toHaveLength(1);
        expect(result[0]!.id).toBe("PRRT_1");
    });

    test("two pages — accumulates nodes from both pages", async () => {
        const page2 = makePrPage(["PRRT_2"], false);
        const deps = makeShellDeps([{ stdout: page2 }]);
        const firstNodes = [makeThreadNode("PRRT_1")];
        const firstPageInfo = { hasNextPage: true, endCursor: "cursor1" };
        const result = await paginate(
            deps,
            firstNodes,
            firstPageInfo,
            { owner: "o", repo: "r", number: 1 },
            PR_THREADS_QUERY,
            PrThreadsPageSchema,
            extractPrPage,
            "error",
        );
        expect(result).toHaveLength(2);
        expect(result[0]!.id).toBe("PRRT_1");
        expect(result[1]!.id).toBe("PRRT_2");
    });

    test("extractPage returning null triggers ScriptError", async () => {
        const page2 = JSON.stringify({ data: { repository: null } });
        const deps = makeShellDeps([{ stdout: page2, exitCode: 0 }]);
        const firstNodes = [makeThreadNode("PRRT_1")];
        const firstPageInfo = { hasNextPage: true, endCursor: "cursor1" };
        await expect(
            paginate(
                deps,
                firstNodes,
                firstPageInfo,
                { owner: "o", repo: "r", number: 1 },
                PR_THREADS_QUERY,
                PrThreadsPageSchema,
                extractPrPage,
                "error",
            ),
        ).rejects.toThrow("unexpected null page during pagination");
    });
});
