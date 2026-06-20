import type { EnvDep, FileSysDep, ShellDep } from "@adda/lib";
import type { GitHubIssueHeader } from "@adda/lib";
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
    issueStateOnly = false,
): Promise<CurrentIssueResult> {
    // Step 1: Validate env vars
    const { owner, repo } = requireOwnerRepo(deps);

    // Step 2: Check dirty tree (skip if issueStateOnly)
    if (!issueStateOnly) {
        const statusResult = await deps.shell.run(["git", "status", "--porcelain"], { strict: false });
        if (statusResult.stdout.trim()) {
            throw new CurrentIssueError(
                "dirty_tree",
                "working tree is dirty — commit or stash changes before switching issues",
            );
        }
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

    // Step 4: Resolve branch (read-only GraphQL API call, safe to run always)
    const resolveData = await resolveIssueBranch(deps, issueId);

    // Step 5: Enrich with hierarchy context
    // Parent: degrade gracefully on inaccessible foreign repo
    let parentHeader: GitHubIssueHeader | null = null;
    let hierarchyWarning: string | undefined;
    try {
        parentHeader = await fetchParent(deps, Number(issueId));
    } catch (e) {
        hierarchyWarning = e instanceof Error ? e.message : String(e);
    }

    // Children: always current repo — hard fail on any error
    // Siblings: pass cached parent (null on failure → returns [] without fetching)
    const [childrenHeaders, siblingHeaders] = await Promise.all([
        fetchChildren(deps, Number(issueId)),
        fetchSiblings(deps, Number(issueId), parentHeader),
    ]);

    // Step 6: Determine branch
    const branch = resolveData.resolution === "main" ? "main" : resolveData.branch;

    // Step 7: Checkout branch (skip if issueStateOnly)
    if (!issueStateOnly) {
        await deps.shell.run(["git", "checkout", branch]);
    }

    // Step 8: Pull from origin to ensure local branch is up to date (skip if issueStateOnly)
    if (!issueStateOnly) {
        await deps.shell.run(["git", "pull"]);
    }

    // Step 9: Write state and emit success
    const issueState: IssueState = {
        id: issueId,
        title,
        type: typeLabel,
        phase: phaseLabel,
        state: state === "CLOSED" ? "closed" : "open",
        pr: resolveData.pr,
        owner,
        repo,
        parent: parentHeader,
        children: childrenHeaders,
        siblings: siblingHeaders,
    };

    await store.writeState(issueState);

    // Step 10: Run repo-level init hook (skip if issueStateOnly)
    const hook = await runRepoInitHook(deps, issueStateOnly ? true : skipRepoInit);

    const details: Record<string, unknown> = { branch, resolution: resolveData.resolution, hook };
    if (hierarchyWarning !== undefined) details.hierarchyWarning = hierarchyWarning;
    return { issue: issueState, details };
}
