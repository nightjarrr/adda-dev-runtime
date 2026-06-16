// children subcommand handler for issue-hierarchy.
import type { EnvDep, ShellDep } from "@adda/lib";
import { buildIssueHeader, parseJson, requireOwnerRepo, ScriptZodValidationError } from "@adda/lib";
import type { GitHubIssueHeader } from "@adda/lib";
import { RawIssueSchema } from "./types";
import type { ChildrenResult, IssueHierarchyArgs } from "./types";

// --- Fetch ---

export async function fetchChildren(deps: ShellDep & EnvDep, parentNumber: number): Promise<GitHubIssueHeader[]> {
    const { owner, repo } = requireOwnerRepo(deps);
    const result = await deps.shell.run([
        "gh",
        "api",
        "--paginate",
        "--jq",
        ".[]",
        `/repos/${owner}/${repo}/issues/${parentNumber}/sub_issues`,
    ]);

    const lines = result.stdout.split("\n").filter((l) => l.trim() !== "");
    if (lines.length === 0) return [];

    return lines.map((line) => {
        const raw = parseJson(line);
        const parsed = RawIssueSchema.safeParse(raw);
        if (!parsed.success) throw new ScriptZodValidationError("unexpected sub_issues response", parsed.error, raw);
        return buildIssueHeader({ ...parsed.data, parent: parentNumber });
    });
}

export async function runChildren(
    deps: ShellDep & EnvDep,
    args: Extract<IssueHierarchyArgs, { subcommand: "children" }>,
): Promise<ChildrenResult> {
    const children = await fetchChildren(deps, args.parentNumber);
    return { parent: args.parentNumber, children };
}
