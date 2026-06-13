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
import { defaultDeps, ScriptBase, ScriptStructuredError } from "@adda/lib";

import { runPr } from "./pr-review-threads/pr";
import { runThread } from "./pr-review-threads/thread";
import type { PrReviewThreadsArgs } from "./pr-review-threads/types";

const DEFAULT_MAX_UNRESOLVED = 50;

type PrReviewThreadsDeps = ShellDep & EnvDep & StdioDep & TmpDep & FileWriterDep & FileSysDep;

export class PrReviewThreadsScript extends ScriptBase<PrReviewThreadsDeps, PrReviewThreadsArgs> {
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
            throw new ScriptStructuredError(
                {
                    status: "error",
                    error: "mode is required: pr <pr-number> [--include-resolved] [--max-unresolved <n>]  or  thread <thread-id>",
                },
                "mode is required: pr <pr-number> [--include-resolved] [--max-unresolved <n>]  or  thread <thread-id>",
                2,
            );
        }

        if (mode === "pr") {
            const prArg = parsed.positionals[1];
            if (!prArg) {
                throw new ScriptStructuredError(
                    { status: "error", error: "pr mode requires a PR number as the second argument" },
                    "pr mode requires a PR number as the second argument",
                    2,
                );
            }
            const prNumber = Number(prArg);
            if (!Number.isInteger(prNumber) || prNumber <= 0) {
                throw new ScriptStructuredError(
                    { status: "error", error: `invalid PR number '${prArg}': must be a positive integer` },
                    `invalid PR number '${prArg}': must be a positive integer`,
                    2,
                );
            }

            const maxUnresolvedArg = parsed.values["max-unresolved"] as string | undefined;
            let maxUnresolved = DEFAULT_MAX_UNRESOLVED;
            if (maxUnresolvedArg !== undefined) {
                maxUnresolved = Number(maxUnresolvedArg);
                if (!Number.isInteger(maxUnresolved) || maxUnresolved <= 0) {
                    throw new ScriptStructuredError(
                        {
                            status: "error",
                            error: `invalid --max-unresolved '${maxUnresolvedArg}': must be a positive integer`,
                        },
                        `invalid --max-unresolved '${maxUnresolvedArg}': must be a positive integer`,
                        2,
                    );
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
                throw new ScriptStructuredError(
                    { status: "error", error: "--include-resolved is not valid for 'thread'" },
                    "--include-resolved is not valid for 'thread'",
                    2,
                );
            }
            if (parsed.values["max-unresolved"] !== undefined) {
                throw new ScriptStructuredError(
                    { status: "error", error: "--max-unresolved is not valid for 'thread'" },
                    "--max-unresolved is not valid for 'thread'",
                    2,
                );
            }

            const threadId = parsed.positionals[1];
            if (!threadId) {
                throw new ScriptStructuredError(
                    { status: "error", error: "thread mode requires a thread id as the second argument" },
                    "thread mode requires a thread id as the second argument",
                    2,
                );
            }
            return { mode: "thread", threadId };
        }

        throw new ScriptStructuredError(
            { status: "error", error: `unknown mode '${mode}': expected 'pr' or 'thread'` },
            `unknown mode '${mode}': expected 'pr' or 'thread'`,
            2,
        );
    }

    protected async execute(args: PrReviewThreadsArgs): Promise<void> {
        if (args.mode === "pr") {
            this.emit(await runPr(this.deps, args));
        } else {
            this.emit(await runThread(this.deps, args));
        }
    }
}

if (import.meta.main) process.exit(await new PrReviewThreadsScript(defaultDeps).run(process.argv));
