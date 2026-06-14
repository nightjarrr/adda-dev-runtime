import type { ShellDep } from "@adda/lib";
import { makeEnvelopeSchema, parseJson, ScriptZodValidationError } from "@adda/lib";
import { z } from "zod";

import { CurrentIssueError } from "./types";
import type { CurrentIssueReason } from "./types";

export const RESOLVE_ISSUE_BRANCH_BIN = "/usr/local/libexec/adda-dev-runtime/bin/resolve-issue-branch";

const ResolveResultSchema = z.object({
    issue_id: z.string(),
    resolution: z.enum(["feature_branch", "main"]),
    branch: z.string(),
    pr: z.string(),
});

export const ResolveIssueBranchOutputSchema = makeEnvelopeSchema(ResolveResultSchema);

export type ResolveIssueBranchData = z.infer<typeof ResolveResultSchema>;

export async function resolveIssueBranch(deps: ShellDep, issueId: string): Promise<ResolveIssueBranchData> {
    const resolveResult = await deps.shell.run([RESOLVE_ISSUE_BRANCH_BIN, issueId], { strict: false });
    if (resolveResult.exitCode !== 0) {
        throw new CurrentIssueError("resolve_failed", `resolve-issue-branch failed for issue #${issueId}`, {
            verboseStderr: resolveResult.stderr,
        });
    }

    let resolveRaw: unknown;
    try {
        resolveRaw = parseJson(resolveResult.stdout);
    } catch {
        throw new CurrentIssueError("api_error", `invalid JSON from resolve-issue-branch for issue #${issueId}`);
    }

    const resolveParsed = ResolveIssueBranchOutputSchema.safeParse(resolveRaw);
    if (!resolveParsed.success) {
        const err = new ScriptZodValidationError("unexpected resolve-issue-branch output", resolveParsed.error, resolveRaw);
        throw new CurrentIssueError("validation_error", err.message, { verboseStderr: err.verboseStderr });
    }

    const data = resolveParsed.data;

    if (data.status === "fail") {
        // reason is re-propagated from resolve-issue-branch; cast to CurrentIssueReason
        // which covers all GithubReason codes that the binary can emit
        const reason = data.error.reason as CurrentIssueReason;
        throw new CurrentIssueError(reason, data.error.message, {
            details: data.error.details,
            verboseStderr: resolveResult.stderr,
        });
    }

    return data.result;
}
