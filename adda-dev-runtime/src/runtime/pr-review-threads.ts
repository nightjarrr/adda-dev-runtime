// pr-review-threads — query open PR review threads via GitHub GraphQL.
//
// Usage:
//   pr-review-threads pr <pr-number> [--include-resolved] [--max-unresolved <n>]
//   pr-review-threads thread <thread-id>
//
// Inputs:
//   GITHUB_OWNER, GITHUB_REPO — required for pr mode
//   ADDA_DEV_PR_REVIEW_SCAN_CEILING — optional; positive int; default 1000
//
// Outputs:
//   stdout: JSON envelope (mode-keyed: .pr or .thread)
//   file:   detail file at /tmp/pr-review-threads-{pr|thread}-…-<epoch-ms>.json
import type { parseArgs } from "node:util";
import type { EnvDep, FileWriterDep, FileSysDep, ShellDep, StdioDep, TmpDep } from "@adda/lib";
import { defaultDeps, ScriptBase } from "@adda/lib";

import { Output } from "./pr-review-threads/output";
import { runPr } from "./pr-review-threads/pr";
import { runThread } from "./pr-review-threads/thread";
import type { PrReviewThreadsArgs } from "./pr-review-threads/types";

const DEFAULT_MAX_UNRESOLVED = 50;

type PrReviewThreadsDeps = ShellDep & EnvDep & StdioDep & TmpDep & FileWriterDep & FileSysDep;

export class PrReviewThreadsScript extends ScriptBase<PrReviewThreadsDeps, PrReviewThreadsArgs> {
    private readonly output = new Output(this.deps);

    protected argDefinitions(): Parameters<typeof parseArgs>[0] {
        return {
            allowPositionals: true,
            strict: true,
            options: {
                "include-resolved": { type: "boolean" as const },
                "max-unresolved": { type: "string" as const },
            },
        };
    }

    protected validateArgs(parsed: ReturnType<typeof parseArgs>): PrReviewThreadsArgs {
        const mode = parsed.positionals[0];
        if (!mode) {
            this.output.failKeyless(
                "mode is required: pr <pr-number> [--include-resolved] [--max-unresolved <n>]  or  thread <thread-id>",
            );
        }

        if (mode === "pr") {
            const prArg = parsed.positionals[1];
            if (!prArg) {
                this.output.failKeyless("pr mode requires a PR number as the second argument");
            }
            const prNumber = Number(prArg);
            if (!Number.isInteger(prNumber) || prNumber <= 0) {
                this.output.failKeyless(`invalid PR number '${prArg}': must be a positive integer`);
            }

            const maxUnresolvedArg = parsed.values["max-unresolved"] as string | undefined;
            let maxUnresolved = DEFAULT_MAX_UNRESOLVED;
            if (maxUnresolvedArg !== undefined) {
                maxUnresolved = Number(maxUnresolvedArg);
                if (!Number.isInteger(maxUnresolved) || maxUnresolved <= 0) {
                    this.output.failKeyless(`invalid --max-unresolved '${maxUnresolvedArg}': must be a positive integer`);
                }
            }

            return {
                mode: "pr",
                prNumber,
                includeResolved: (parsed.values["include-resolved"] as boolean | undefined) ?? false,
                maxUnresolved,
            };
        }

        if (mode === "thread") {
            if (parsed.values["include-resolved"] !== undefined) {
                this.output.failKeyless("--include-resolved is not valid for 'thread'");
            }
            if (parsed.values["max-unresolved"] !== undefined) {
                this.output.failKeyless("--max-unresolved is not valid for 'thread'");
            }

            const threadId = parsed.positionals[1];
            if (!threadId) {
                this.output.failKeyless("thread mode requires a thread id as the second argument");
            }
            return { mode: "thread", threadId };
        }

        return this.output.failKeyless(`unknown mode '${mode}': expected 'pr' or 'thread'`);
    }

    protected async execute(args: PrReviewThreadsArgs): Promise<void> {
        if (args.mode === "pr") {
            await runPr(this.deps, args, this.output);
        } else {
            await runThread(this.deps, args, this.output);
        }
    }
}

if (import.meta.main) process.exit(await new PrReviewThreadsScript(defaultDeps).run(process.argv));
