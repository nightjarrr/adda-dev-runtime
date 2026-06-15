// children subcommand handler for issue-hierarchy.
import type { EnvDep, ShellDep } from "@adda/lib";
import { fetchChildren, requireOwnerRepo } from "./fetch";
import type { ChildrenResult, IssueHierarchyArgs } from "./types";

export async function runChildren(
    deps: ShellDep & EnvDep,
    args: Extract<IssueHierarchyArgs, { subcommand: "children" }>,
): Promise<ChildrenResult> {
    const { owner, repo } = requireOwnerRepo(deps);
    const children = await fetchChildren(deps, owner, repo, args.parentNumber);
    return { parent: args.parentNumber, children };
}
