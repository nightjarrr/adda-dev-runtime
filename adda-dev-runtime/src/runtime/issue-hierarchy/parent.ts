// parent subcommand handler for issue-hierarchy.
// Supports read (query parent), set (--set <number>), and unset (--set NONE) operations.
import { z } from "zod";
import type { EnvDep, ShellDep } from "@adda/lib";
import { buildIssueHeader, parseJson, requireOwnerRepo, ScriptError, ScriptZodValidationError } from "@adda/lib";
import type { GitHubIssueHeader } from "@adda/lib";
import type { IssueHierarchyArgs, ParentResult } from "./types";

// --- Schema for /issues/{n} response ---

const IssueWithParentSchema = z.object({
    number: z.number(),
    title: z.string(),
    state: z.enum(["open", "closed"]),
    id: z.number(),
    labels: z.array(z.object({ name: z.string() })),
    parent_issue_url: z.string().nullable().optional(),
});

// --- Internal helpers ---

function parseParentNumber(parentUrl: string | null | undefined): number | null {
    if (!parentUrl) return null;
    const parts = parentUrl.replace(/\/+$/, "").split("/");
    return Number(parts[parts.length - 1]!);
}

async function fetchIssueById(deps: ShellDep & EnvDep, issueNumber: number): Promise<z.infer<typeof IssueWithParentSchema>> {
    const { owner, repo } = requireOwnerRepo(deps);
    const result = await deps.shell.run(["gh", "api", `/repos/${owner}/${repo}/issues/${issueNumber}`]);
    const raw = parseJson(result.stdout);
    const parsed = IssueWithParentSchema.safeParse(raw);
    if (!parsed.success) throw new ScriptZodValidationError("unexpected issue response", parsed.error, raw);
    return parsed.data;
}

// --- Public exports ---

export async function fetchParent(deps: ShellDep & EnvDep, issueNumber: number): Promise<GitHubIssueHeader | null> {
    const issue = await fetchIssueById(deps, issueNumber);
    if (!issue.parent_issue_url) return null;

    const { owner, repo } = requireOwnerRepo(deps);
    const parentNumber = parseParentNumber(issue.parent_issue_url);
    const result = await deps.shell.run(["gh", "api", `/repos/${owner}/${repo}/issues/${parentNumber}`]);
    const raw = parseJson(result.stdout);
    const parsed = IssueWithParentSchema.safeParse(raw);
    if (!parsed.success) throw new ScriptZodValidationError("unexpected parent issue response", parsed.error, raw);
    return buildIssueHeader(parsed.data);
}

export async function runParent(
    deps: ShellDep & EnvDep,
    args: Extract<IssueHierarchyArgs, { subcommand: "parent" }>,
): Promise<ParentResult> {
    const { owner, repo } = requireOwnerRepo(deps);
    const issue = await fetchIssueById(deps, args.issueNumber);

    if (args.setParent !== undefined) {
        if (args.setParent === null) {
            // Remove parent
            if (issue.parent_issue_url) {
                const parentNumber = parseParentNumber(issue.parent_issue_url);
                await deps.shell.run([
                    "gh",
                    "api",
                    "--method",
                    "DELETE",
                    `/repos/${owner}/${repo}/issues/${parentNumber}/sub_issue`,
                    "-F",
                    `sub_issue_id=${issue.id}`,
                ]);
            }
        } else {
            // Set parent (optionally replace)
            const replace = !!issue.parent_issue_url;
            const params = ["-F", `sub_issue_id=${issue.id}`];
            if (replace) params.push("-F", "replace_parent=true");

            await deps.shell.run([
                "gh",
                "api",
                "--method",
                "POST",
                `/repos/${owner}/${repo}/issues/${args.setParent}/sub_issues`,
                ...params,
            ]);
        }
    }

    // Re-fetch current state after any mutation
    const parent = await fetchParent(deps, args.issueNumber);

    // Verify write took effect
    if (args.setParent !== undefined) {
        if (args.setParent === null) {
            if (parent !== null) {
                throw new ScriptError(
                    "internal_error",
                    `parent removal verification failed: issue #${args.issueNumber} still has parent`,
                );
            }
        } else {
            if (parent === null || parent.number !== args.setParent) {
                throw new ScriptError(
                    "internal_error",
                    `parent set verification failed: expected parent #${args.setParent}, got ${
                        parent ? `#${parent.number}` : "null"
                    }`,
                );
            }
        }
    }

    return { issue: args.issueNumber, parent };
}
