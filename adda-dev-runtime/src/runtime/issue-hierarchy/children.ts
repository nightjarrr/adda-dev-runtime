// children subcommand handler for issue-hierarchy.
import { z } from "zod";
import type { EnvDep, ShellDep } from "@adda/lib";
import { buildIssueHeader, parseJson, requireOwnerRepo, ScriptZodValidationError } from "@adda/lib";
import type { GitHubIssueHeader } from "@adda/lib";
import type { ChildrenResult, IssueHierarchyArgs } from "./types";

// --- Schema for raw API response (sub_issues endpoint) ---

export const RawIssueSchema = z.object({
    number: z.number(),
    title: z.string(),
    state: z.enum(["open", "closed"]),
    labels: z.array(z.object({ name: z.string() })),
});

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
