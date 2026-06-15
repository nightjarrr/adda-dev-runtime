// siblings subcommand handler for issue-hierarchy.
// Returns all issues that share the same parent as the given issue, excluding the given issue itself.
import type { EnvDep, ShellDep } from "@adda/lib";
import type { GitHubIssueHeader } from "@adda/lib";
import { fetchChildren } from "./children";
import { fetchParent } from "./parent";
import type { IssueHierarchyArgs, SiblingsResult } from "./types";

export async function fetchSiblings(deps: ShellDep & EnvDep, issueNumber: number): Promise<GitHubIssueHeader[]> {
    const parent = await fetchParent(deps, issueNumber);
    if (!parent) return [];

    const children = await fetchChildren(deps, parent.number);
    return children.filter((c) => c.number !== issueNumber);
}

export async function runSiblings(
    deps: ShellDep & EnvDep,
    args: Extract<IssueHierarchyArgs, { subcommand: "siblings" }>,
): Promise<SiblingsResult> {
    const siblings = await fetchSiblings(deps, args.issueNumber);
    return { issue: args.issueNumber, siblings };
}
