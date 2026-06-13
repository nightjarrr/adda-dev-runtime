import type { ShellDep, StdioDep } from "@adda/lib";
import { parseJson, ScriptZodValidationError } from "@adda/lib";
import { z } from "zod";

import { CurrentIssueError } from "./errors";

export const RESOLVE_ISSUE_BRANCH_BIN = "/usr/local/libexec/adda-dev-runtime/bin/resolve-issue-branch";

export const ResolveIssueBranchOutputSchema = z.object({
    status: z.string(),
    branch: z.string(),
    pr: z.string(),
    details: z.string(),
});

export type ResolveIssueBranchData = z.infer<typeof ResolveIssueBranchOutputSchema>;

export async function resolveIssueBranch(deps: ShellDep & StdioDep, issueId: string): Promise<ResolveIssueBranchData> {
    const resolveResult = await deps.shell.run([RESOLVE_ISSUE_BRANCH_BIN, issueId], { strict: false });
    if (resolveResult.exitCode !== 0) {
        deps.stdio.stderr.write(resolveResult.stderr);
        throw new CurrentIssueError(`resolve-issue-branch failed for issue #${issueId}`);
    }

    let resolveRaw: unknown;
    try {
        resolveRaw = parseJson(resolveResult.stdout);
    } catch {
        throw new CurrentIssueError(`invalid JSON from resolve-issue-branch for issue #${issueId}`);
    }

    const resolveParsed = ResolveIssueBranchOutputSchema.safeParse(resolveRaw);
    if (!resolveParsed.success) {
        const err = new ScriptZodValidationError("unexpected resolve-issue-branch output", resolveParsed.error, resolveRaw);
        throw new CurrentIssueError(err.short, {}, err.message);
    }

    const resolveData = resolveParsed.data;

    if (resolveData.status === "ambiguous" || resolveData.status === "error") {
        deps.stdio.stderr.write(resolveResult.stderr);
        throw new CurrentIssueError(
            `resolve-issue-branch returned '${resolveData.status}' for issue #${issueId}: ${resolveData.details}`,
        );
    }

    return resolveData;
}
