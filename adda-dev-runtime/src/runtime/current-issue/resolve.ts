import type { ShellDep } from "@adda/lib";
import { makeEnvelopeSchema, parseJson, ScriptZodValidationError } from "@adda/lib";
import { z } from "zod";

import { CurrentIssueError } from "./errors";

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
        throw new CurrentIssueError(`resolve-issue-branch failed for issue #${issueId}`, resolveResult.stderr);
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
        throw new CurrentIssueError(err.message, err.verboseStderr);
    }

    const data = resolveParsed.data;

    if (data.status === "fail") {
        throw new CurrentIssueError(data.error.message, resolveResult.stderr, { reason: data.error.reason });
    }

    return data.result;
}
