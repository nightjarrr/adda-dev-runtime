import type { ShellDep } from "@adda/lib";
import { parseJson, ScriptZodValidationError } from "@adda/lib";
import { z } from "zod";

import type { ScriptOutput } from "./types";

export const RESOLVE_ISSUE_BRANCH_BIN = "/usr/local/libexec/adda-dev-runtime/bin/resolve-issue-branch";

export const ResolveIssueBranchOutputSchema = z.object({
    status: z.string(),
    branch: z.string(),
    pr: z.string(),
    details: z.string(),
});

export type ResolveIssueBranchData = z.infer<typeof ResolveIssueBranchOutputSchema>;

export async function resolveIssueBranch(
    deps: ShellDep,
    issueId: string,
    output: ScriptOutput,
): Promise<ResolveIssueBranchData> {
    const resolveResult = await deps.shell.run([RESOLVE_ISSUE_BRANCH_BIN, issueId], { strict: false });
    if (resolveResult.exitCode !== 0) {
        output.forwardStderr(resolveResult);
        output.fail(`resolve-issue-branch failed for issue #${issueId}`);
    }

    let resolveRaw: unknown;
    try {
        resolveRaw = parseJson(resolveResult.stdout);
    } catch {
        output.fail(`invalid JSON from resolve-issue-branch for issue #${issueId}`);
    }

    const resolveParsed = ResolveIssueBranchOutputSchema.safeParse(resolveRaw);
    if (!resolveParsed.success) {
        const err = new ScriptZodValidationError("unexpected resolve-issue-branch output", resolveParsed.error, resolveRaw);
        output.emit({ status: "error", issue: null, details: {}, error: err.short });
        throw err;
    }

    const resolveData = resolveParsed.data;

    if (resolveData.status === "ambiguous" || resolveData.status === "error") {
        output.forwardStderr(resolveResult);
        output.fail(`resolve-issue-branch returned '${resolveData.status}' for issue #${issueId}: ${resolveData.details}`);
    }

    return resolveData;
}
