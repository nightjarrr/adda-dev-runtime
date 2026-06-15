// Fetch helpers for issue-hierarchy: sub-issue fetcher.
import type { EnvDep, ShellDep } from "@adda/lib";
import { buildIssueHeader, parseJson, RawIssueSchema, requireOwnerRepo, ScriptZodValidationError } from "@adda/lib";
import type { GitHubIssueHeader } from "@adda/lib";

export { requireOwnerRepo };

// --- Fetch ---

export async function fetchChildren(
    deps: ShellDep & EnvDep,
    owner: string,
    repo: string,
    parentNumber: number,
): Promise<GitHubIssueHeader[]> {
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
