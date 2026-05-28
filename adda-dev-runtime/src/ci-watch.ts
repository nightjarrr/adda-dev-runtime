import type { parseArgs } from "node:util";
import type { ShellDep, SleepDep, StdioDep, TmpDep } from "@adda/lib";
import { defaultDeps, ScriptArgsError, ScriptBase, ScriptError } from "@adda/lib";

type CiWatchDeps = ShellDep & TmpDep & StdioDep & SleepDep;

interface RunRecord {
    runId: string;
    event: string;
    url: string;
    conclusion: string;
    logFile: string;
}

interface SuccessWatchResult {
    conclusion: "success";
    elapsed_seconds: number;
}

interface FailedWatchResult {
    conclusion: "failure";
    elapsed_seconds: number;
    runs: RunRecord[];
}

type CiWatchOutput = SuccessWatchResult | FailedWatchResult;

const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 10000;

export class CiWatchScript extends ScriptBase<CiWatchDeps> {
    protected argDefinitions(): Parameters<typeof parseArgs>[0] {
        return {
            options: {
                branch: { type: "string" as const },
                tag: { type: "string" as const },
                commit: { type: "string" as const },
            },
            allowPositionals: true,
        };
    }

    protected async execute(parsed: ReturnType<typeof parseArgs>): Promise<void> {
        const mode = parsed.positionals[0];

        if (!mode) {
            throw new ScriptArgsError("mode is required: push --branch <name>|--tag <tag>|--commit <sha>  or  pr <pr-number>");
        }

        if (mode === "push") {
            const branch = parsed.values.branch as string | undefined;
            const tag = parsed.values.tag as string | undefined;
            const commit = parsed.values.commit as string | undefined;

            const setCount = [branch, tag, commit].filter((v) => v !== undefined).length;
            if (setCount !== 1) {
                throw new ScriptArgsError("push mode requires exactly one of --branch, --tag, or --commit");
            }

            const sha = await this.resolvePushSha(branch, tag, commit);
            await this.watchPush(sha);
        } else if (mode === "pr") {
            const prNumber = parsed.positionals[1];
            if (!prNumber) {
                throw new ScriptArgsError("pr mode requires a PR number as the second argument");
            }
            await this.watchPr(prNumber);
        } else {
            throw new ScriptArgsError(`unknown mode '${mode}': expected 'push' or 'pr'`);
        }
    }

    private async resolveRemoteSha(ref: string): Promise<string> {
        const result = await this.deps.shell.run(["git", "ls-remote", "origin", ref]);
        if (result.exitCode !== 0) {
            throw new ScriptError(`git ls-remote failed: ${result.stderr.trim()}`, 1);
        }
        const sha = result.stdout.trim().split("\t")[0] ?? "";
        return sha;
    }

    private async resolvePushSha(
        branch: string | undefined,
        tag: string | undefined,
        commit: string | undefined,
    ): Promise<string> {
        if (commit !== undefined) {
            return commit;
        }

        if (branch !== undefined) {
            let resolvedBranch = branch;
            if (branch === "LOCAL") {
                const localResult = await this.deps.shell.run(["git", "branch", "--show-current"]);
                resolvedBranch = localResult.stdout.trim();
                if (!resolvedBranch) {
                    throw new ScriptArgsError("cannot determine current local branch");
                }
            }

            const sha = await this.resolveRemoteSha(resolvedBranch);
            if (!sha) {
                throw new ScriptArgsError(`cannot resolve branch '${resolvedBranch}' on origin`);
            }
            return sha;
        }

        // tag is defined (setCount === 1 guarantees one of branch/tag/commit is set)
        const tagName = tag as string;

        const peeledSha = await this.resolveRemoteSha(`refs/tags/${tagName}^{}`);
        if (peeledSha) {
            return peeledSha;
        }

        const tagSha = await this.resolveRemoteSha(`refs/tags/${tagName}`);
        if (!tagSha) {
            throw new ScriptArgsError(`cannot resolve tag '${tagName}' on origin`);
        }
        return tagSha;
    }

    private async watchPush(sha: string): Promise<void> {
        const startMs = Date.now();
        let pollElapsed = 0;

        let runIds: string[] = await this.fetchPushRunIds(sha);

        while (runIds.length === 0) {
            if (pollElapsed >= POLL_TIMEOUT_MS) {
                throw new ScriptError(`no push run found for commit ${sha} after ${POLL_TIMEOUT_MS / 1000}s`, 1);
            }
            await this.deps.sleep.sleep(POLL_INTERVAL_MS);
            pollElapsed += POLL_INTERVAL_MS;

            runIds = await this.fetchPushRunIds(sha);
        }

        await Promise.all(runIds.map((id) => this.deps.shell.run(["gh", "run", "watch", id])));

        const conclusions = await Promise.all(runIds.map((id) => this.fetchRunConclusion(id)));
        const failingRuns = conclusions.filter((c) => c.conclusion !== "success");

        const getElapsed = () => Math.round((Date.now() - startMs) / 1000);

        if (failingRuns.length === 0) {
            this.emit({ conclusion: "success", elapsed_seconds: getElapsed() });
            return;
        }

        const runs = await this.collectFailingRuns(failingRuns);
        this.emit({ conclusion: "failure", elapsed_seconds: getElapsed(), runs });
        throw new ScriptError("CI runs failed", 1);
    }

    private async watchPr(prNumber: string): Promise<void> {
        const startMs = Date.now();

        await this.deps.shell.run(["gh", "pr", "checks", prNumber, "--watch"]);

        const checksResult = await this.deps.shell.run(["gh", "pr", "checks", prNumber, "--json", "name,state,link"]);
        if (checksResult.exitCode !== 0) {
            throw new ScriptError(`gh pr checks failed: ${checksResult.stderr.trim() || checksResult.stdout.trim()}`, 1);
        }

        interface CheckEntry {
            name: string;
            state: string;
            link: string;
        }

        const checks: CheckEntry[] = JSON.parse(checksResult.stdout.trim() || "[]");
        const failingChecks = checks.filter((c) => c.state.toLowerCase() !== "success");

        const getElapsed = () => Math.round((Date.now() - startMs) / 1000);

        if (failingChecks.length === 0) {
            this.emit({ conclusion: "success", elapsed_seconds: getElapsed() });
            return;
        }

        const runIdSet = new Set<string>();
        for (const check of failingChecks) {
            const match = /\/runs\/(\d+)/.exec(check.link);
            if (!match) {
                this.deps.stdio.stderr.write(`Warning: could not extract run ID from link: ${check.link}\n`);
                continue;
            }
            runIdSet.add(match[1]);
        }

        const runIds = Array.from(runIdSet);
        const runsWithConclusion = await Promise.all(runIds.map((id) => this.fetchRunConclusion(id)));
        const runs = await this.collectFailingRuns(runsWithConclusion);
        this.emit({ conclusion: "failure", elapsed_seconds: getElapsed(), runs });
        throw new ScriptError("CI runs failed", 1);
    }

    private async fetchPushRunIds(sha: string): Promise<string[]> {
        const result = await this.deps.shell.run([
            "gh",
            "run",
            "list",
            "--commit",
            sha,
            "--event",
            "push",
            "--json",
            "databaseId",
        ]);
        return this.parseRunIds(result.stdout.trim());
    }

    private async fetchRunConclusion(runId: string): Promise<{ runId: string; conclusion: string }> {
        const r = await this.deps.shell.run(["gh", "run", "view", runId, "--json", "conclusion", "-q", ".conclusion"]);
        return { runId, conclusion: r.stdout.trim() };
    }

    private async collectFailingRuns(runs: Array<{ runId: string; conclusion: string }>): Promise<RunRecord[]> {
        return Promise.all(
            runs.map(async ({ runId, conclusion }) => {
                const [urlResult, eventResult] = await Promise.all([
                    this.deps.shell.run(["gh", "run", "view", runId, "--json", "url", "-q", ".url"]),
                    this.deps.shell.run(["gh", "run", "view", runId, "--json", "event", "-q", ".event"]),
                ]);
                const logFile = this.deps.tmp.tempFilePath("ci-watch-logs", ".txt");
                await this.deps.shell.runSh(`gh run view ${runId} --log-failed > ${logFile} 2>&1 || true`);
                return { runId, conclusion, url: urlResult.stdout.trim(), event: eventResult.stdout.trim(), logFile };
            }),
        );
    }

    private parseRunIds(json: string): string[] {
        if (!json) return [];
        try {
            const parsed = JSON.parse(json) as Array<{ databaseId: number | string }>;
            if (!Array.isArray(parsed) || parsed.length === 0) return [];
            return parsed.map((r) => String(r.databaseId));
        } catch {
            return [];
        }
    }

    private emit(output: CiWatchOutput): void {
        this.deps.stdio.stdout.write(`${JSON.stringify(output)}\n`);
    }
}

if (import.meta.main) process.exit(await new CiWatchScript(defaultDeps).run(process.argv));
