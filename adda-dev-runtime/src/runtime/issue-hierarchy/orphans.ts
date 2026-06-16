// orphans subcommand handler for issue-hierarchy.
import type { EnvDep, ShellDep } from "@adda/lib";
import { buildIssueHeader, parseJson, requireOwnerRepo, ScriptZodValidationError } from "@adda/lib";
import { RawIssueSchema } from "./types";
import type { OrphansResult, IssueHierarchyArgs } from "./types";

const PER_PAGE = 100;

export async function runOrphans(
    deps: ShellDep & EnvDep,
    args: Extract<IssueHierarchyArgs, { subcommand: "orphans" }>,
): Promise<OrphansResult> {
    const { owner, repo } = requireOwnerRepo(deps);
    const state = args.includeClosed ? "all" : "open";

    const result = await deps.shell.run([
        "gh",
        "api",
        "--paginate",
        "--jq",
        `.[] | select(.pull_request == null and (has("parent_issue_url") | not))`,
        `/repos/${owner}/${repo}/issues?state=${state}&per_page=${PER_PAGE}`,
    ]);

    const lines = result.stdout.split("\n").filter((l) => l.trim() !== "");
    const orphans = lines.map((line) => {
        const raw = parseJson(line);
        const parsed = RawIssueSchema.safeParse(raw);
        if (!parsed.success) throw new ScriptZodValidationError("unexpected issue response", parsed.error, raw);
        return buildIssueHeader(parsed.data);
    });

    return { orphans };
}
