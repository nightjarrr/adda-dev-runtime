import type { parseArgs } from "node:util";
import type { ShellDep, SleepDep, StdioDep, TmpDep } from "@adda/lib";
import { defaultDeps, parseJson, ScriptArgsError, ScriptBase, ScriptError, ScriptZodValidationError } from "@adda/lib";
import { z } from "zod";

const ChecksSchema = z.array(z.object({ name: z.string(), state: z.string(), link: z.string() }));
const RunListSchema = z.array(z.object({ databaseId: z.union([z.number(), z.string()]) }));

type CiWatchDeps = ShellDep & TmpDep & StdioDep & SleepDep;

type CiWatchRef = { branch: string } | { tag: string } | { commit: string };
type CiWatchArgs = { mode: "push"; ref: CiWatchRef } | { mode: "pr"; prNumber: string };

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

const TERMINAL_STATES = new Set([
    "success",
    "failure",
    "cancelled",
    "timed_out",
    "action_required",
    "neutral",
    "skipped",
    "stale",
    "startup_failure",
]);

export class CiWatchScript extends ScriptBase<CiWatchDeps, CiWatchArgs> {
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

    protected validateArgs(parsed: ReturnType<typeof parseArgs>): CiWatchArgs {
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

            const ref: CiWatchRef =
                branch !== undefined ? { branch } : tag !== undefined ? { tag } : { commit: commit as string };
            return { mode: "push", ref };
        }

        if (mode === "pr") {
            const prNumber = parsed.positionals[1];
            if (!prNumber) {
                throw new ScriptArgsError("pr mode requires a PR number as the second argument");
            }
            return { mode: "pr", prNumber };
        }

        throw new ScriptArgsError(`unknown mode '${mode}': expected 'push' or 'pr'`);
    }

    protected async execute(args: CiWatchArgs): Promise<void> {
        if (args.mode === "push") {
            const sha = await this.resolvePushSha(args.ref);
            await this.watchPush(sha);
        } else {
            await this.watchPr(args.prNumber);
        }
    }

    private async resolveRemoteSha(ref: string): Promise<string> {
        const result = await this.deps.shell.run(["git", "ls-remote", "origin", ref]);
        return result.stdout.trim().split("\t")[0] ?? "";
    }

    private async resolvePushSha(ref: CiWatchRef): Promise<string> {
        if ("commit" in ref) {
            return ref.commit;
        }

        if ("branch" in ref) {
            let resolvedBranch = ref.branch;
            if (ref.branch === "LOCAL") {
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

        // "tag" in ref
        const tagName = ref.tag;

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

        const conclusions = await this.watchAndFetchConclusions(runIds);
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

        await this.deps.shell.run(["gh", "pr", "checks", prNumber, "--watch"], { strict: false });

        const checksResult = await this.deps.shell.run(["gh", "pr", "checks", prNumber, "--json", "name,state,link"]);
        const checksRaw = parseJson(checksResult.stdout.trim() || "[]");
        const checksParsed = ChecksSchema.safeParse(checksRaw);
        if (!checksParsed.success)
            throw new ScriptZodValidationError("unexpected gh pr checks output", checksParsed.error, checksRaw);
        const checks = checksParsed.data;

        // Phase 1 — partition checks into terminal and non-terminal
        const nonTerminalChecks = checks.filter((c) => !TERMINAL_STATES.has(c.state.toLowerCase()));
        const terminalChecks = checks.filter((c) => TERMINAL_STATES.has(c.state.toLowerCase()));

        // Phase 2 — wait for non-terminal runs to finish
        const { runIds: nonTerminalRunIds } = this.extractRunIds(nonTerminalChecks);
        const nonTerminalConclusions = await this.watchAndFetchConclusions(nonTerminalRunIds);

        // Phase 3 — build combined set of failing run IDs
        const terminalFailingChecks = terminalChecks.filter((c) => c.state.toLowerCase() !== "success");
        const { runIds: terminalFailingRunIds, hasUnresolvable: hasUnresolvableFailure } =
            this.extractRunIds(terminalFailingChecks);
        const failingRunIdSet = new Set(terminalFailingRunIds);

        for (const { runId, conclusion } of nonTerminalConclusions) {
            if (conclusion !== "success") {
                failingRunIdSet.add(runId);
            }
        }

        const getElapsed = () => Math.round((Date.now() - startMs) / 1000);

        // Phase 4 — emit result
        if (failingRunIdSet.size === 0 && !hasUnresolvableFailure) {
            this.emit({ conclusion: "success", elapsed_seconds: getElapsed() });
            return;
        }

        const failingRunIds = Array.from(failingRunIdSet);
        const runsWithConclusion = await Promise.all(failingRunIds.map((id) => this.fetchRunConclusion(id)));
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
                await this.deps.shell.runSh(`gh run view ${runId} --log-failed > ${logFile}`);
                return { runId, conclusion, url: urlResult.stdout.trim(), event: eventResult.stdout.trim(), logFile };
            }),
        );
    }

    private extractRunIds(checks: Array<{ link: string }>): { runIds: string[]; hasUnresolvable: boolean } {
        let hasUnresolvable = false;
        const runIdSet = new Set<string>();
        for (const check of checks) {
            const match = /\/runs\/(\d+)/.exec(check.link);
            if (!match) {
                this.deps.stdio.stderr.write(`Warning: could not extract run ID from link: ${check.link}\n`);
                hasUnresolvable = true;
                continue;
            }
            runIdSet.add(match[1]);
        }
        return { runIds: Array.from(runIdSet), hasUnresolvable };
    }

    private async watchAndFetchConclusions(runIds: string[]): Promise<Array<{ runId: string; conclusion: string }>> {
        await Promise.all(runIds.map((id) => this.deps.shell.run(["gh", "run", "watch", id], { strict: false })));
        return Promise.all(runIds.map((id) => this.fetchRunConclusion(id)));
    }

    private parseRunIds(json: string): string[] {
        if (!json) return [];
        const raw = parseJson(json);
        const result = RunListSchema.safeParse(raw);
        if (!result.success) throw new ScriptZodValidationError("unexpected gh run list output", result.error, raw);
        return result.data.map((r) => String(r.databaseId));
    }

    private emit(output: CiWatchOutput): void {
        this.deps.stdio.stdout.write(`${JSON.stringify(output)}\n`);
    }
}

if (import.meta.main) process.exit(await new CiWatchScript(defaultDeps).run(process.argv));
