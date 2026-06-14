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
import type { EnvDep, FileWriterDep, ShellDep, StdioDep } from "@adda/lib";
import { defaultDeps, ScriptBase } from "@adda/lib";

import { runPr } from "./pr-review-threads/pr";
import { runThread } from "./pr-review-threads/thread";
import { PrReviewError } from "./pr-review-threads/types";
import type { PrReviewThreadsArgs } from "./pr-review-threads/types";

const DEFAULT_MAX_UNRESOLVED = 50;

type PrReviewThreadsDeps = ShellDep & EnvDep & StdioDep & FileWriterDep;

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
            throw new PrReviewError(
                "invalid_args",
                "mode is required: pr <pr-number> [--include-resolved] [--max-unresolved <n>]  or  thread <thread-id>",
                { exitCode: 2 },
            );
        }

        if (mode === "pr") {
            const prArg = parsed.positionals[1];
            if (!prArg) {
                throw new PrReviewError("invalid_args", "pr mode requires a PR number as the second argument", {
                    exitCode: 2,
                });
            }
            const prNumber = Number(prArg);
            if (!Number.isInteger(prNumber) || prNumber <= 0) {
                throw new PrReviewError("invalid_args", `invalid PR number '${prArg}': must be a positive integer`, {
                    exitCode: 2,
                });
            }

            const maxUnresolvedArg = parsed.values["max-unresolved"] as string | undefined;
            let maxUnresolved = DEFAULT_MAX_UNRESOLVED;
            if (maxUnresolvedArg !== undefined) {
                maxUnresolved = Number(maxUnresolvedArg);
                if (!Number.isInteger(maxUnresolved) || maxUnresolved <= 0) {
                    throw new PrReviewError(
                        "invalid_args",
                        `invalid --max-unresolved '${maxUnresolvedArg}': must be a positive integer`,
                        { exitCode: 2 },
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
                throw new PrReviewError("invalid_args", "--include-resolved is not valid for 'thread'", {
                    exitCode: 2,
                });
            }
            if (parsed.values["max-unresolved"] !== undefined) {
                throw new PrReviewError("invalid_args", "--max-unresolved is not valid for 'thread'", {
                    exitCode: 2,
                });
            }

            const threadId = parsed.positionals[1];
            if (!threadId) {
                throw new PrReviewError("invalid_args", "thread mode requires a thread id as the second argument", {
                    exitCode: 2,
                });
            }
            return { mode: "thread", threadId };
        }

        throw new PrReviewError("invalid_args", `unknown mode '${mode}': expected 'pr' or 'thread'`, {
            exitCode: 2,
        });
    }

    protected async execute(args: PrReviewThreadsArgs): Promise<void> {
        if (args.mode === "pr") {
            const { header, resultsFile } = await runPr(this.deps, args);
            this.emit({ status: "ok", result: { pr: header, resultsFile }, error: null });
        } else {
            const { header, resultsFile } = await runThread(this.deps, args);
            this.emit({ status: "ok", result: { thread: header, resultsFile }, error: null });
        }
    }
}

if (import.meta.main) process.exit(await new PrReviewThreadsScript(defaultDeps).run(process.argv));
