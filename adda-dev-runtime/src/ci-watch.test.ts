import { describe, expect, mock, test } from "bun:test";
import { CiWatchScript } from "./ci-watch";
import type { Shell, ShellDep, ShellResult, Sleep, SleepDep, StdioDep, Tmp, TmpDep } from "./lib/index";

type CiWatchDeps = ShellDep & TmpDep & StdioDep & SleepDep;

// --- Mock helpers ---

function makeShellResult(stdout: string, exitCode = 0, stderr = ""): ShellResult {
    return { stdout, stderr, exitCode };
}

interface MockDepsOptions {
    runQueue?: ShellResult[];
    runShQueue?: ShellResult[];
    sleepMs?: number[];
    tmpPrefix?: string;
}

function makeMockDeps(options: MockDepsOptions = {}): {
    deps: CiWatchDeps;
    outLines: string[];
    errLines: string[];
    runCalls: string[][];
    runShCalls: string[];
    sleepCalls: number[];
} {
    const outLines: string[] = [];
    const errLines: string[] = [];
    const runCalls: string[][] = [];
    const runShCalls: string[] = [];
    const sleepCalls: number[] = [];

    const runQueue = options.runQueue ? [...options.runQueue] : [];
    const runShQueue = options.runShQueue ? [...options.runShQueue] : [];

    const mockShell: Shell = {
        run: mock(async (command: string[]) => {
            runCalls.push(command);
            const result = runQueue.shift();
            return result ?? makeShellResult("");
        }),
        runSh: mock(async (command: string) => {
            runShCalls.push(command);
            const result = runShQueue.shift();
            return result ?? makeShellResult("");
        }),
    };

    let tmpCounter = 0;
    const mockTmp: Tmp = {
        tempFilePath: mock((prefix = "tmp", suffix = "") => {
            tmpCounter++;
            return `/tmp/${prefix}-test-uuid-${tmpCounter}${suffix}`;
        }),
        makeTempDir: mock(() => "/tmp/test-dir"),
    };

    const mockSleep: Sleep = {
        sleep: mock(async (ms: number) => {
            sleepCalls.push(ms);
        }),
    };

    const deps: CiWatchDeps = {
        shell: mockShell,
        tmp: mockTmp,
        sleep: mockSleep,
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

    return { deps, outLines, errLines, runCalls, runShCalls, sleepCalls };
}

function getStdoutJson(outLines: string[]): CiWatchOutputShape {
    return JSON.parse(outLines.join("").trim()) as CiWatchOutputShape;
}

interface RunRecordShape {
    runId: string;
    event: string;
    url: string;
    conclusion: string;
    logFile: string;
}

type CiWatchOutputShape =
    | { conclusion: "success"; elapsed: number }
    | { conclusion: "failure"; elapsed: number; runs: RunRecordShape[] };

// --- Reusable run data builders ---

function makeRunListJson(runIds: number[]): string {
    return JSON.stringify(runIds.map((id) => ({ databaseId: id })));
}

// --- Tests ---

describe("CiWatchScript", () => {
    // ---------------------------------------------------------------
    // Argument validation
    // ---------------------------------------------------------------
    describe("argument validation", () => {
        test("no args — exits 2", async () => {
            const { deps } = makeMockDeps();
            const script = new CiWatchScript(deps);
            const code = await script.run(["bun", "ci-watch.ts"]);
            expect(code).toBe(2);
        });

        test("unknown mode — exits 2", async () => {
            const { deps } = makeMockDeps();
            const script = new CiWatchScript(deps);
            const code = await script.run(["bun", "ci-watch.ts", "deploy"]);
            expect(code).toBe(2);
        });

        test("push with no option — exits 2", async () => {
            const { deps } = makeMockDeps();
            const script = new CiWatchScript(deps);
            const code = await script.run(["bun", "ci-watch.ts", "push"]);
            expect(code).toBe(2);
        });

        test("push with multiple options (--branch + --tag) — exits 2", async () => {
            const { deps } = makeMockDeps();
            const script = new CiWatchScript(deps);
            const code = await script.run(["bun", "ci-watch.ts", "push", "--branch", "main", "--tag", "v1.0"]);
            expect(code).toBe(2);
        });

        test("push with multiple options (--branch + --commit) — exits 2", async () => {
            const { deps } = makeMockDeps();
            const script = new CiWatchScript(deps);
            const code = await script.run(["bun", "ci-watch.ts", "push", "--branch", "main", "--commit", "abc123"]);
            expect(code).toBe(2);
        });

        test("pr with no number — exits 2", async () => {
            const { deps } = makeMockDeps();
            const script = new CiWatchScript(deps);
            const code = await script.run(["bun", "ci-watch.ts", "pr"]);
            expect(code).toBe(2);
        });
    });

    // ---------------------------------------------------------------
    // SHA resolution — push branch
    // ---------------------------------------------------------------
    describe("SHA resolution — push branch", () => {
        test("--branch main resolves correctly and calls watchPush with parsed SHA", async () => {
            const sha = "abc123def456";
            const { deps, outLines, runCalls } = makeMockDeps({
                runQueue: [
                    makeShellResult(`${sha}\trefs/heads/main\n`), // ls-remote
                    makeShellResult(makeRunListJson([11111])), // run list
                    makeShellResult(""), // run watch
                    makeShellResult("success\n"), // run view conclusion
                ],
            });
            const script = new CiWatchScript(deps);
            const code = await script.run(["bun", "ci-watch.ts", "push", "--branch", "main"]);
            expect(code).toBe(0);
            expect(runCalls[0]).toEqual(["git", "ls-remote", "origin", "main"]);
            expect(runCalls[1]).toContain(sha);
            const out = getStdoutJson(outLines);
            expect(out.conclusion).toBe("success");
        });

        test("--branch returns empty SHA — exits 2", async () => {
            const { deps, errLines } = makeMockDeps({
                runQueue: [makeShellResult("")], // ls-remote returns nothing
            });
            const script = new CiWatchScript(deps);
            const code = await script.run(["bun", "ci-watch.ts", "push", "--branch", "nonexistent"]);
            expect(code).toBe(2);
            expect(errLines.join("")).toContain("nonexistent");
        });

        test("--branch with ls-remote non-zero exit — exits 1 (infra failure, not args error)", async () => {
            const { deps, errLines } = makeMockDeps({
                runQueue: [makeShellResult("", 128, "fatal: repository not found")],
            });
            const script = new CiWatchScript(deps);
            const code = await script.run(["bun", "ci-watch.ts", "push", "--branch", "main"]);
            expect(code).toBe(1);
            expect(errLines.join("")).toContain("git ls-remote failed");
        });

        test("--branch LOCAL resolves local branch name first, then remote SHA", async () => {
            const sha = "localsha123";
            const { deps, runCalls } = makeMockDeps({
                runQueue: [
                    makeShellResult("feature/my-branch\n"), // git branch --show-current
                    makeShellResult(`${sha}\trefs/heads/feature/my-branch\n`), // ls-remote
                    makeShellResult(makeRunListJson([22222])), // run list
                    makeShellResult(""), // run watch
                    makeShellResult("success\n"), // run view conclusion
                ],
            });
            const script = new CiWatchScript(deps);
            const code = await script.run(["bun", "ci-watch.ts", "push", "--branch", "LOCAL"]);
            expect(code).toBe(0);
            expect(runCalls[0]).toEqual(["git", "branch", "--show-current"]);
            expect(runCalls[1]).toEqual(["git", "ls-remote", "origin", "feature/my-branch"]);
        });

        test("--branch LOCAL with empty local branch — exits 2", async () => {
            const { deps } = makeMockDeps({
                runQueue: [makeShellResult("")], // git branch --show-current returns empty
            });
            const script = new CiWatchScript(deps);
            const code = await script.run(["bun", "ci-watch.ts", "push", "--branch", "LOCAL"]);
            expect(code).toBe(2);
        });
    });

    // ---------------------------------------------------------------
    // SHA resolution — push tag
    // ---------------------------------------------------------------
    describe("SHA resolution — push tag", () => {
        test("--tag v1.0 with peeled SHA found — uses peeled SHA", async () => {
            const peeledSha = "peeledsha123";
            const { deps, runCalls } = makeMockDeps({
                runQueue: [
                    makeShellResult(`${peeledSha}\trefs/tags/v1.0^{}\n`), // ls-remote peeled
                    makeShellResult(makeRunListJson([33333])), // run list
                    makeShellResult(""), // run watch
                    makeShellResult("success\n"), // run view conclusion
                ],
            });
            const script = new CiWatchScript(deps);
            const code = await script.run(["bun", "ci-watch.ts", "push", "--tag", "v1.0"]);
            expect(code).toBe(0);
            expect(runCalls[0]).toEqual(["git", "ls-remote", "origin", "refs/tags/v1.0^{}"]);
            expect(runCalls[1]).toContain(peeledSha);
        });

        test("--tag v1.0 with no peeled but non-peeled found — uses non-peeled SHA", async () => {
            const tagSha = "tagsha456";
            const { deps, runCalls } = makeMockDeps({
                runQueue: [
                    makeShellResult(""), // ls-remote peeled returns nothing
                    makeShellResult(`${tagSha}\trefs/tags/v1.0\n`), // ls-remote non-peeled
                    makeShellResult(makeRunListJson([44444])), // run list
                    makeShellResult(""), // run watch
                    makeShellResult("success\n"), // run view conclusion
                ],
            });
            const script = new CiWatchScript(deps);
            const code = await script.run(["bun", "ci-watch.ts", "push", "--tag", "v1.0"]);
            expect(code).toBe(0);
            expect(runCalls[1]).toEqual(["git", "ls-remote", "origin", "refs/tags/v1.0"]);
            expect(runCalls[2]).toContain(tagSha);
        });

        test("--tag v1.0 with neither found — exits 2", async () => {
            const { deps } = makeMockDeps({
                runQueue: [
                    makeShellResult(""), // peeled
                    makeShellResult(""), // non-peeled
                ],
            });
            const script = new CiWatchScript(deps);
            const code = await script.run(["bun", "ci-watch.ts", "push", "--tag", "v1.0"]);
            expect(code).toBe(2);
        });

        test("--tag with ls-remote non-zero exit (peeled) — exits 1 (infra failure)", async () => {
            const { deps, errLines } = makeMockDeps({
                runQueue: [makeShellResult("", 128, "fatal: unable to connect")],
            });
            const script = new CiWatchScript(deps);
            const code = await script.run(["bun", "ci-watch.ts", "push", "--tag", "v1.0"]);
            expect(code).toBe(1);
            expect(errLines.join("")).toContain("git ls-remote failed");
        });
    });

    // ---------------------------------------------------------------
    // SHA resolution — push commit
    // ---------------------------------------------------------------
    describe("SHA resolution — push commit", () => {
        test("--commit abc123 calls watchPush directly with that SHA", async () => {
            const sha = "abc123";
            const { deps, runCalls } = makeMockDeps({
                runQueue: [
                    makeShellResult(makeRunListJson([55555])), // run list
                    makeShellResult(""), // run watch
                    makeShellResult("success\n"), // run view conclusion
                ],
            });
            const script = new CiWatchScript(deps);
            const code = await script.run(["bun", "ci-watch.ts", "push", "--commit", sha]);
            expect(code).toBe(0);
            // First run call should be gh run list with the sha
            expect(runCalls[0]).toContain(sha);
        });
    });

    // ---------------------------------------------------------------
    // watchPush — polling
    // ---------------------------------------------------------------
    describe("watchPush — polling", () => {
        test("first poll returns runs immediately — no sleep called", async () => {
            const { deps, sleepCalls } = makeMockDeps({
                runQueue: [
                    makeShellResult(makeRunListJson([66666])), // run list immediately returns
                    makeShellResult(""), // run watch
                    makeShellResult("success\n"), // conclusion
                ],
            });
            const script = new CiWatchScript(deps);
            const code = await script.run(["bun", "ci-watch.ts", "push", "--commit", "sha1"]);
            expect(code).toBe(0);
            expect(sleepCalls).toHaveLength(0);
        });

        test("first poll empty, second has runs — sleep called once with POLL_INTERVAL_MS", async () => {
            const { deps, sleepCalls } = makeMockDeps({
                runQueue: [
                    makeShellResult("[]"), // first poll: empty
                    makeShellResult(makeRunListJson([77777])), // second poll: runs found
                    makeShellResult(""), // run watch
                    makeShellResult("success\n"), // conclusion
                ],
            });
            const script = new CiWatchScript(deps);
            const code = await script.run(["bun", "ci-watch.ts", "push", "--commit", "sha2"]);
            expect(code).toBe(0);
            expect(sleepCalls).toHaveLength(1);
            expect(sleepCalls[0]).toBe(2000);
        });

        test("poll timeout reached — exits 1 with error on stderr", async () => {
            // Need enough empty results to exhaust the timeout
            // POLL_TIMEOUT_MS=10000, POLL_INTERVAL_MS=2000 → 5 retries
            const emptyPolls = Array.from({ length: 6 }, () => makeShellResult("[]"));
            const { deps, errLines } = makeMockDeps({ runQueue: emptyPolls });
            const script = new CiWatchScript(deps);
            const code = await script.run(["bun", "ci-watch.ts", "push", "--commit", "sha3"]);
            expect(code).toBe(1);
            expect(errLines.join("")).toContain("Error:");
        });
    });

    // ---------------------------------------------------------------
    // watchPush — all runs succeed
    // ---------------------------------------------------------------
    describe("watchPush — all runs succeed", () => {
        test("watches each run, checks all conclusions = success, outputs success JSON, exits 0", async () => {
            const { deps, outLines, runCalls } = makeMockDeps({
                runQueue: [
                    makeShellResult(makeRunListJson([111, 222])), // run list: two runs
                    makeShellResult(""), // run watch 111
                    makeShellResult(""), // run watch 222
                    makeShellResult("success\n"), // conclusion 111
                    makeShellResult("success\n"), // conclusion 222
                ],
            });
            const script = new CiWatchScript(deps);
            const code = await script.run(["bun", "ci-watch.ts", "push", "--commit", "sha4"]);
            expect(code).toBe(0);

            // watch calls for both run IDs
            const watchCalls = runCalls.filter((c) => c[0] === "gh" && c[1] === "run" && c[2] === "watch");
            expect(watchCalls).toHaveLength(2);
            expect(watchCalls[0]).toContain("111");
            expect(watchCalls[1]).toContain("222");

            const out = getStdoutJson(outLines);
            expect(out.conclusion).toBe("success");
            expect(out.elapsed).toBeGreaterThanOrEqual(0);
        });
    });

    // ---------------------------------------------------------------
    // watchPush — one run fails
    // ---------------------------------------------------------------
    describe("watchPush — one run fails", () => {
        test("collects url/event/conclusion/logFile, outputs failure JSON, exits 1, stderr has Error:", async () => {
            const { deps, outLines, errLines, runShCalls } = makeMockDeps({
                runQueue: [
                    makeShellResult(makeRunListJson([333])), // run list
                    makeShellResult(""), // run watch (Promise.all)
                    makeShellResult("failure\n"), // fetchRunConclusion (Promise.all)
                    // collectFailingRuns for run 333 (url and event in parallel):
                    makeShellResult("https://github.com/repo/actions/runs/333\n"), // url
                    makeShellResult("push\n"), // event
                ],
                runShQueue: [makeShellResult("")], // log fetch
            });
            const script = new CiWatchScript(deps);
            const code = await script.run(["bun", "ci-watch.ts", "push", "--commit", "sha5"]);
            expect(code).toBe(1);
            expect(errLines.join("")).toContain("Error:");

            const out = getStdoutJson(outLines);
            expect(out.conclusion).toBe("failure");
            expect(out.elapsed).toBeGreaterThanOrEqual(0);
            if (out.conclusion !== "failure") throw new Error("expected failure");
            expect(out.runs).toHaveLength(1);
            expect(out.runs[0].runId).toBe("333");
            expect(out.runs[0].event).toBe("push");
            expect(out.runs[0].url).toBe("https://github.com/repo/actions/runs/333");
            // conclusion comes from fetchRunConclusion, not re-fetched in collectFailingRuns
            expect(out.runs[0].conclusion).toBe("failure");
            expect(out.runs[0].logFile).toMatch(/^\/tmp\/ci-watch-logs-.+\.txt$/);

            // runSh called with correct command
            expect(runShCalls[0]).toMatch(/gh run view 333 --log-failed > .+ 2>&1 \|\| true/);
        });
    });

    // ---------------------------------------------------------------
    // watchPr — gh pr checks --json non-zero exit
    // ---------------------------------------------------------------
    describe("watchPr — gh pr checks --json failure", () => {
        test("gh pr checks --json non-zero exit — exits 1 (not silent success)", async () => {
            const { deps, errLines } = makeMockDeps({
                runQueue: [
                    makeShellResult(""), // gh pr checks --watch
                    makeShellResult("", 1, "API error: GraphQL error"), // gh pr checks --json non-zero
                ],
            });
            const script = new CiWatchScript(deps);
            const code = await script.run(["bun", "ci-watch.ts", "pr", "42"]);
            expect(code).toBe(1);
            expect(errLines.join("")).toContain("gh pr checks failed");
        });
    });

    // ---------------------------------------------------------------
    // watchPr — all checks pass
    // ---------------------------------------------------------------
    describe("watchPr — all checks pass", () => {
        test("calls gh pr checks --watch then --json, all SUCCESS → stdout success JSON, exit 0", async () => {
            const checksJson = JSON.stringify([
                { name: "build", state: "SUCCESS", link: "https://github.com/repo/actions/runs/999/jobs/1" },
                { name: "test", state: "success", link: "https://github.com/repo/actions/runs/999/jobs/2" },
            ]);
            const { deps, outLines, runCalls } = makeMockDeps({
                runQueue: [
                    makeShellResult(""), // gh pr checks --watch
                    makeShellResult(checksJson), // gh pr checks --json
                ],
            });
            const script = new CiWatchScript(deps);
            const code = await script.run(["bun", "ci-watch.ts", "pr", "42"]);
            expect(code).toBe(0);

            expect(runCalls[0]).toEqual(["gh", "pr", "checks", "42", "--watch"]);
            expect(runCalls[1]).toEqual(["gh", "pr", "checks", "42", "--json", "name,state,link"]);

            const out = getStdoutJson(outLines);
            expect(out.conclusion).toBe("success");
            expect(out.elapsed).toBeGreaterThanOrEqual(0);
        });
    });

    // ---------------------------------------------------------------
    // watchPr — some checks fail
    // ---------------------------------------------------------------
    describe("watchPr — some checks fail", () => {
        test("extracts run IDs from .link via regex, outputs failure JSON, exits 1", async () => {
            const checksJson = JSON.stringify([
                { name: "build", state: "FAILURE", link: "https://github.com/repo/actions/runs/500/jobs/1" },
                { name: "test", state: "SUCCESS", link: "https://github.com/repo/actions/runs/501/jobs/2" },
            ]);
            const { deps, outLines } = makeMockDeps({
                runQueue: [
                    makeShellResult(""), // gh pr checks --watch
                    makeShellResult(checksJson), // gh pr checks --json
                    // fetchRunConclusion for run 500 (Promise.all):
                    makeShellResult("failure\n"),
                    // collectFailingRuns for run 500 (url and event in parallel):
                    makeShellResult("https://github.com/repo/actions/runs/500\n"),
                    makeShellResult("pull_request\n"),
                ],
                runShQueue: [makeShellResult("")],
            });
            const script = new CiWatchScript(deps);
            const code = await script.run(["bun", "ci-watch.ts", "pr", "42"]);
            expect(code).toBe(1);

            const out = getStdoutJson(outLines);
            expect(out.conclusion).toBe("failure");
            expect(out.elapsed).toBeGreaterThanOrEqual(0);
            if (out.conclusion !== "failure") throw new Error("expected failure");
            expect(out.runs).toHaveLength(1);
            expect(out.runs[0].runId).toBe("500");
            // conclusion comes from fetchRunConclusion, not re-fetched in collectFailingRuns
            expect(out.runs[0].conclusion).toBe("failure");
        });

        test("deduplicates run IDs (two failing checks same run)", async () => {
            const checksJson = JSON.stringify([
                { name: "job-a", state: "FAILURE", link: "https://github.com/repo/actions/runs/600/jobs/1" },
                { name: "job-b", state: "FAILURE", link: "https://github.com/repo/actions/runs/600/jobs/2" },
            ]);
            const { deps, outLines } = makeMockDeps({
                runQueue: [
                    makeShellResult(""), // gh pr checks --watch
                    makeShellResult(checksJson), // gh pr checks --json
                    // fetchRunConclusion for run 600 only once (Promise.all):
                    makeShellResult("failure\n"),
                    // collectFailingRuns for run 600 only once (url and event in parallel):
                    makeShellResult("https://github.com/repo/actions/runs/600\n"),
                    makeShellResult("push\n"),
                ],
                runShQueue: [makeShellResult("")],
            });
            const script = new CiWatchScript(deps);
            const code = await script.run(["bun", "ci-watch.ts", "pr", "42"]);
            expect(code).toBe(1);

            const out = getStdoutJson(outLines);
            expect(out.elapsed).toBeGreaterThanOrEqual(0);
            if (out.conclusion !== "failure") throw new Error("expected failure");
            // Only one run record even though two checks pointed to it
            expect(out.runs).toHaveLength(1);
            expect(out.runs[0].runId).toBe("600");
        });

        test("check with lowercase 'failure' state is treated as failing (case-insensitive)", async () => {
            const checksJson = JSON.stringify([
                { name: "build", state: "failure", link: "https://github.com/repo/actions/runs/700/jobs/1" },
            ]);
            const { deps, outLines } = makeMockDeps({
                runQueue: [
                    makeShellResult(""), // gh pr checks --watch
                    makeShellResult(checksJson), // gh pr checks --json
                    makeShellResult("failure\n"), // fetchRunConclusion for run 700
                    makeShellResult("https://github.com/repo/actions/runs/700\n"), // url
                    makeShellResult("pull_request\n"), // event
                ],
                runShQueue: [makeShellResult("")],
            });
            const script = new CiWatchScript(deps);
            const code = await script.run(["bun", "ci-watch.ts", "pr", "42"]);
            expect(code).toBe(1);

            const out = getStdoutJson(outLines);
            expect(out.conclusion).toBe("failure");
            expect(out.elapsed).toBeGreaterThanOrEqual(0);
            if (out.conclusion !== "failure") throw new Error("expected failure");
            expect(out.runs).toHaveLength(1);
            expect(out.runs[0].runId).toBe("700");
        });

        test("link with no extractable run ID — warning on stderr, continues", async () => {
            const checksJson = JSON.stringify([
                { name: "external-check", state: "FAILURE", link: "https://example.com/no-run-id" },
            ]);
            const { deps, errLines, outLines } = makeMockDeps({
                runQueue: [
                    makeShellResult(""), // gh pr checks --watch
                    makeShellResult(checksJson), // gh pr checks --json
                    // no collectFailingRuns calls since no run IDs extracted
                ],
            });
            const script = new CiWatchScript(deps);
            const code = await script.run(["bun", "ci-watch.ts", "pr", "42"]);
            // Exits 1 because there are failing checks even if no run IDs could be extracted
            expect(code).toBe(1);
            expect(errLines.join("")).toContain("Warning:");
            const out = getStdoutJson(outLines);
            expect(out.conclusion).toBe("failure");
            expect(out.elapsed).toBeGreaterThanOrEqual(0);
            if (out.conclusion !== "failure") throw new Error("expected failure");
            expect(out.runs).toHaveLength(0);
        });
    });

    // ---------------------------------------------------------------
    // collectFailingRuns
    // ---------------------------------------------------------------
    describe("collectFailingRuns", () => {
        test("fetches url/event per run (conclusion passed in), runSh called with correct command, logFile has correct shape", async () => {
            const runId = "789";
            const { deps, outLines, runShCalls } = makeMockDeps({
                runQueue: [
                    makeShellResult(makeRunListJson([Number(runId)])), // run list
                    makeShellResult(""), // run watch (Promise.all)
                    makeShellResult("failure\n"), // fetchRunConclusion (Promise.all)
                    // collectFailingRuns — url and event in parallel:
                    makeShellResult("https://github.com/repo/actions/runs/789\n"), // url
                    makeShellResult("push\n"), // event
                    // no conclusion re-fetch
                ],
                runShQueue: [makeShellResult("")],
            });
            const script = new CiWatchScript(deps);
            await script.run(["bun", "ci-watch.ts", "push", "--commit", "commitsha"]);

            // runSh called with gh run view <id> --log-failed > <path> 2>&1 || true
            expect(runShCalls).toHaveLength(1);
            expect(runShCalls[0]).toMatch(/^gh run view 789 --log-failed > \/tmp\/ci-watch-logs-.+\.txt 2>&1 \|\| true$/);

            const out = getStdoutJson(outLines);
            expect(out.elapsed).toBeGreaterThanOrEqual(0);
            if (out.conclusion !== "failure") throw new Error("expected failure");
            expect(out.runs[0].logFile).toMatch(/^\/tmp\/ci-watch-logs-.+\.txt$/);
            // conclusion in output comes from fetchRunConclusion, not a re-fetch
            expect(out.runs[0].conclusion).toBe("failure");
        });
    });
});
