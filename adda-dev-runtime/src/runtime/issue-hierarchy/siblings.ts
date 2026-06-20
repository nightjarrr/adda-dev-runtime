// siblings subcommand handler for issue-hierarchy.
// Returns all issues that share the same parent as the given issue, excluding the given issue itself.
import type { EnvDep, ShellDep } from "@adda/lib";
import type { GitHubIssueHeader } from "@adda/lib";
import { fetchChildren } from "./children";
import { fetchParent } from "./parent";
import type { IssueHierarchyArgs, SiblingsResult } from "./types";

export async function fetchSiblings(
    deps: ShellDep & EnvDep,
    issueNumber: number,
    cachedParent?: GitHubIssueHeader | null,
): Promise<GitHubIssueHeader[]> {
    let parent: GitHubIssueHeader | null;

    if (cachedParent === null) {
        // Caller signaled parent is inaccessible or absent — no siblings
        return [];
    } else if (cachedParent !== undefined) {
        // Use the pre-fetched parent; skip another API round-trip
        parent = cachedParent;
    } else {
        // Default CLI path: fetch parent internally (errors propagate)
        parent = await fetchParent(deps, issueNumber);
    }

    if (!parent) return [];

    const children = await fetchChildren(deps, parent.number, { owner: parent.owner, repo: parent.repo });
    return children.filter((c) => c.number !== issueNumber);
}

export async function runSiblings(
    deps: ShellDep & EnvDep,
    args: Extract<IssueHierarchyArgs, { subcommand: "siblings" }>,
): Promise<SiblingsResult> {
    const siblings = await fetchSiblings(deps, args.issueNumber);
    return { issue: args.issueNumber, siblings };
}
