import type { EnvDep, FileSysDep, ShellDep } from "@adda/lib";
import { parseJson, requireOwnerRepo, ScriptZodValidationError } from "@adda/lib";
import { fetchChildren, fetchParent, fetchSiblings } from "../issue-hierarchy";

import { runRepoInitHook } from "./hook";
import { resolveIssueBranch } from "./resolve";
import { CurrentIssueError } from "./types";
import { GhIssueSchema } from "./types";
import type { CurrentIssueResult, IssueState, IssueStateStore } from "./types";

export async function executeSwitch(
    issueId: string,
    skipRepoInit: boolean,
    deps: ShellDep & EnvDep & FileSysDep,
    store: IssueStateStore,
): Promise<CurrentIssueResult> {
    // Step 1: Validate env vars
    requireOwnerRepo(deps);

    // Step 2: Check dirty tree
    const statusResult = await deps.shell.run(["git", "status", "--porcelain"], { strict: false });
    if (statusResult.stdout.trim()) {
        throw new CurrentIssueError("dirty_tree", "working tree is dirty — commit or stash changes before switching issues");
    }

    // Step 3: Fetch issue metadata
    const ghResult = await deps.shell.run(["gh", "issue", "view", issueId, "--json", "title,labels,state"]);

    let ghRaw: unknown;
    try {
        ghRaw = parseJson(ghResult.stdout);
    } catch {
        throw new CurrentIssueError("api_error", `invalid JSON from gh issue view #${issueId}`);
    }

    const ghParsed = GhIssueSchema.safeParse(ghRaw);
    if (!ghParsed.success) {
        const err = new ScriptZodValidationError("unexpected gh issue response", ghParsed.error, ghRaw);
        throw new CurrentIssueError("validation_error", err.message, { verboseStderr: err.verboseStderr });
    }

    const { title, labels, state } = ghParsed.data;

    const typeLabel = labels.find((l) => /^(feature|bug|chore|docs)$/.test(l.name))?.name ?? "";
    const phaseLabel = labels.find((l) => l.name.startsWith("phase:"))?.name ?? "";

    // Step 4: Resolve branch
    const resolveData = await resolveIssueBranch(deps, issueId);

    // Step 5: Determine branch
    const branch = resolveData.resolution === "main" ? "main" : resolveData.branch;

    // Step 6: Checkout branch
    await deps.shell.run(["git", "checkout", branch]);

    // Step 6a: Pull from origin to ensure local branch is up to date
    await deps.shell.run(["git", "pull"]);

    // Step 7: Enrich with hierarchy context (parallel, fails fast)
    const [parentHeader, childrenHeaders, siblingHeaders] = await Promise.all([
        fetchParent(deps, Number(issueId)),
        fetchChildren(deps, Number(issueId)),
        fetchSiblings(deps, Number(issueId)),
    ]);

    // Step 8: Write state and emit success
    const issueState: IssueState = {
        id: issueId,
        title,
        type: typeLabel,
        phase: phaseLabel,
        state,
        pr: resolveData.pr,
        parent: parentHeader,
        children: childrenHeaders,
        siblings: siblingHeaders,
    };

    await store.writeState(issueState);

    // Step 9: Run repo-level init hook
    const hook = await runRepoInitHook(deps, skipRepoInit);

    return { issue: issueState, details: { branch, resolution: resolveData.resolution, hook } };
}
