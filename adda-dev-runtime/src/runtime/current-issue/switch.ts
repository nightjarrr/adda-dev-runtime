import type { EnvDep, FileSysDep, ShellDep } from "@adda/lib";
import { parseJson, ScriptZodValidationError } from "@adda/lib";
import { z } from "zod";

import { runRepoInitHook } from "./hook";
import { GhIssueSchema } from "./types";
import type { IssueState, IssueStateStore, ScriptOutput } from "./types";

const RESOLVE_ISSUE_BRANCH_BIN = "/usr/local/libexec/adda-dev-runtime/bin/resolve-issue-branch";

const ResolveIssueBranchOutputSchema = z.object({
    status: z.string(),
    branch: z.string(),
    pr: z.string(),
    details: z.string(),
});

function requireEnvVar(deps: EnvDep, name: string, output: ScriptOutput): string {
    const value = deps.env.get(name);
    if (!value) output.fail(`required environment variable '${name}' is not set`);
    return value;
}

export async function executeSwitch(
    issueId: string,
    skipRepoInit: boolean,
    deps: ShellDep & EnvDep & FileSysDep,
    store: IssueStateStore,
    output: ScriptOutput,
): Promise<void> {
    // Step 1: Validate env vars
    requireEnvVar(deps, "GITHUB_OWNER", output);
    requireEnvVar(deps, "GITHUB_REPO", output);

    // Step 2: Check dirty tree
    const statusResult = await deps.shell.run(["git", "status", "--porcelain"], { strict: false });
    if (statusResult.stdout.trim()) {
        output.fail("working tree is dirty — commit or stash changes before switching issues");
    }

    // Step 3: Fetch issue metadata
    const ghResult = await deps.shell.run(["gh", "issue", "view", issueId, "--json", "title,labels,state"], {
        strict: false,
    });
    if (ghResult.exitCode !== 0) {
        output.fail(`failed to fetch issue #${issueId}: ${ghResult.stderr.trim() || ghResult.stdout.trim()}`);
    }

    let ghRaw: unknown;
    try {
        ghRaw = parseJson(ghResult.stdout);
    } catch {
        output.fail(`invalid JSON from gh issue view #${issueId}`);
    }

    const ghParsed = GhIssueSchema.safeParse(ghRaw);
    if (!ghParsed.success) {
        const err = new ScriptZodValidationError("unexpected gh issue response", ghParsed.error, ghRaw);
        output.emit({ status: "error", issue: null, details: {}, error: err.short });
        throw err;
    }

    const { title, labels, state } = ghParsed.data;

    const typeLabel = labels.find((l) => /^(feature|bug|chore|docs)$/.test(l.name))?.name ?? "";
    const phaseLabel = labels.find((l) => l.name.startsWith("phase:"))?.name ?? "";

    // Step 4: Resolve branch
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

    // Step 5: Determine branch
    const branch = resolveData.status === "main" ? "main" : resolveData.branch;

    // Step 6: Checkout branch
    const checkoutResult = await deps.shell.run(["git", "checkout", branch], { strict: false });
    if (checkoutResult.exitCode !== 0) {
        output.fail(`git checkout '${branch}' failed: ${checkoutResult.stderr.trim() || checkoutResult.stdout.trim()}`);
    }

    // Step 7: Write state and emit success
    const issueState: IssueState = {
        id: issueId,
        title,
        type: typeLabel,
        phase: phaseLabel,
        state,
        pr: resolveData.pr,
    };

    await store.writeState(issueState);

    // Step 8: Run repo-level init hook
    const hook = await runRepoInitHook(deps, skipRepoInit, output);

    output.emit({
        status: "success",
        issue: issueState,
        details: { branch, resolution: resolveData.status, hook },
        error: "",
    });
}
