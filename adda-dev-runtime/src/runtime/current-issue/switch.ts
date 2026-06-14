import type { EnvDep, FileSysDep, ScriptEnvelope, ShellDep } from "@adda/lib";
import { parseJson, ScriptZodValidationError } from "@adda/lib";

import { CurrentIssueError } from "./errors";
import { runRepoInitHook } from "./hook";
import { resolveIssueBranch } from "./resolve";
import { GhIssueSchema } from "./types";
import type { CurrentIssueResult, IssueState, IssueStateStore } from "./types";

function requireEnvVar(deps: EnvDep, name: string): string {
    const value = deps.env.get(name);
    if (!value) throw new CurrentIssueError("missing_env", `required environment variable '${name}' is not set`);
    return value;
}

export async function executeSwitch(
    issueId: string,
    skipRepoInit: boolean,
    deps: ShellDep & EnvDep & FileSysDep,
    store: IssueStateStore,
): Promise<ScriptEnvelope<CurrentIssueResult>> {
    // Step 1: Validate env vars
    requireEnvVar(deps, "GITHUB_OWNER");
    requireEnvVar(deps, "GITHUB_REPO");

    // Step 2: Check dirty tree
    const statusResult = await deps.shell.run(["git", "status", "--porcelain"], { strict: false });
    if (statusResult.stdout.trim()) {
        throw new CurrentIssueError("dirty_tree", "working tree is dirty — commit or stash changes before switching issues");
    }

    // Step 3: Fetch issue metadata
    const ghResult = await deps.shell.run(["gh", "issue", "view", issueId, "--json", "title,labels,state"], {
        strict: false,
    });
    if (ghResult.exitCode !== 0) {
        throw new CurrentIssueError(
            "api_error",
            `failed to fetch issue #${issueId}: ${ghResult.stderr.trim() || ghResult.stdout.trim()}`,
            ghResult.stderr,
        );
    }

    let ghRaw: unknown;
    try {
        ghRaw = parseJson(ghResult.stdout);
    } catch {
        throw new CurrentIssueError("api_error", `invalid JSON from gh issue view #${issueId}`);
    }

    const ghParsed = GhIssueSchema.safeParse(ghRaw);
    if (!ghParsed.success) {
        const err = new ScriptZodValidationError("unexpected gh issue response", ghParsed.error, ghRaw);
        throw new CurrentIssueError("validation_error", err.message, err.verboseStderr!);
    }

    const { title, labels, state } = ghParsed.data;

    const typeLabel = labels.find((l) => /^(feature|bug|chore|docs)$/.test(l.name))?.name ?? "";
    const phaseLabel = labels.find((l) => l.name.startsWith("phase:"))?.name ?? "";

    // Step 4: Resolve branch
    const resolveData = await resolveIssueBranch(deps, issueId);

    // Step 5: Determine branch
    const branch = resolveData.resolution === "main" ? "main" : resolveData.branch;

    // Step 6: Checkout branch
    const checkoutResult = await deps.shell.run(["git", "checkout", branch], { strict: false });
    if (checkoutResult.exitCode !== 0) {
        throw new CurrentIssueError(
            "checkout_failed",
            `git checkout '${branch}' failed: ${checkoutResult.stderr.trim() || checkoutResult.stdout.trim()}`,
            checkoutResult.stderr,
        );
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
    const hook = await runRepoInitHook(deps, skipRepoInit);

    return {
        status: "ok",
        result: { issue: issueState, details: { branch, resolution: resolveData.resolution, hook } },
        error: null,
    };
}
