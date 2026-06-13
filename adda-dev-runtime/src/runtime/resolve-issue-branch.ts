import type { parseArgs } from "node:util";
import type { EnvDep, ShellDep, StdioDep } from "@adda/lib";
import { defaultDeps, parseJson, ScriptArgsError, ScriptBase, ScriptError, ScriptZodValidationError } from "@adda/lib";
import { z } from "zod";

type ResolveIssueBranchDeps = ShellDep & EnvDep & StdioDep;

type ResolveIssueBranchArgs = { issueId: string };

type Status = "feature_branch" | "main" | "ambiguous" | "error";

interface ResolveResult {
    issue_id: string;
    status: Status;
    branch: string;
    pr: string;
    details: string;
}

const GraphQLSchema = z.object({
    data: z.object({
        repository: z
            .object({
                issue: z
                    .object({
                        linkedBranches: z.object({
                            nodes: z.array(z.object({ ref: z.object({ name: z.string() }) })),
                        }),
                        timelineItems: z.object({
                            nodes: z.array(
                                z.object({
                                    subject: z
                                        .object({
                                            number: z.number().optional(),
                                            state: z.string().optional(),
                                            headRefName: z.string().optional(),
                                        })
                                        .optional(),
                                }),
                            ),
                        }),
                    })
                    .nullable(),
            })
            .nullable(),
    }),
});

const GRAPHQL_QUERY = `
    query($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) {
        issue(number: $number) {
          linkedBranches(first: 2) {
            nodes { ref { name } }
          }
          timelineItems(itemTypes: [CONNECTED_EVENT], first: 10) {
            nodes {
              ... on ConnectedEvent {
                subject {
                  ... on PullRequest {
                    number
                    state
                    headRefName
                  }
                }
              }
            }
          }
        }
      }
    }`;

export class ResolveIssueBranchScript extends ScriptBase<ResolveIssueBranchDeps, ResolveIssueBranchArgs> {
    protected argDefinitions(): Parameters<typeof parseArgs>[0] {
        return { options: {}, allowPositionals: true };
    }

    protected validateArgs(parsed: ReturnType<typeof parseArgs>): ResolveIssueBranchArgs {
        if (parsed.positionals.length !== 1) {
            this.emitResult("", "error", "", "", "usage: resolve-issue-branch <issue_id>");
            throw new ScriptArgsError("usage: resolve-issue-branch <issue_id>");
        }
        return { issueId: parsed.positionals[0] };
    }

    protected async execute(args: ResolveIssueBranchArgs): Promise<void> {
        const issueId = args.issueId;

        const owner = this.deps.env.get("GITHUB_OWNER");
        if (!owner) {
            this.emitResult(issueId, "error", "", "", "required environment variable 'GITHUB_OWNER' is not set");
            throw new ScriptError("required environment variable 'GITHUB_OWNER' is not set");
        }

        const repo = this.deps.env.get("GITHUB_REPO");
        if (!repo) {
            this.emitResult(issueId, "error", "", "", "required environment variable 'GITHUB_REPO' is not set");
            throw new ScriptError("required environment variable 'GITHUB_REPO' is not set");
        }

        const ghResult = await this.deps.shell.run(
            [
                "gh",
                "api",
                "graphql",
                "-F",
                `owner=${owner}`,
                "-F",
                `repo=${repo}`,
                "-F",
                `number=${issueId}`,
                "-f",
                `query=${GRAPHQL_QUERY}`,
            ],
            { strict: false },
        );

        if (ghResult.exitCode !== 0) {
            const details = `GraphQL API call failed: ${ghResult.stderr.trim() || ghResult.stdout.trim()}`;
            this.emitResult(issueId, "error", "", "", details);
            throw new ScriptError(details);
        }

        let raw: unknown;
        try {
            raw = parseJson(ghResult.stdout);
        } catch (e) {
            this.emitResult(issueId, "error", "", "", "invalid JSON");
            throw e;
        }
        const parsed = GraphQLSchema.safeParse(raw);
        if (!parsed.success) {
            const err = new ScriptZodValidationError("unexpected API response", parsed.error, raw);
            this.emitResult(issueId, "error", "", "", err.short);
            throw err;
        }

        // Domain conditions — null is intentional (not found), not a schema violation
        if (parsed.data.data.repository === null) {
            this.emitResult(issueId, "error", "", "", `repository ${owner}/${repo} not found`);
            throw new ScriptError(`repository ${owner}/${repo} not found`);
        }
        if (parsed.data.data.repository.issue === null) {
            this.emitResult(issueId, "error", "", "", `issue #${issueId} not found in ${owner}/${repo}`);
            throw new ScriptError(`issue #${issueId} not found in ${owner}/${repo}`);
        }

        const issue = parsed.data.data.repository.issue;

        // Resolution tier 1 — linkedBranches
        const linkedNodes = issue.linkedBranches.nodes;
        if (linkedNodes.length === 1) {
            this.emitResult(issueId, "feature_branch", linkedNodes[0].ref.name, "", "");
            return;
        }
        if (linkedNodes.length > 1) {
            const names = linkedNodes.map((n) => n.ref.name).join(", ");
            this.emitResult(issueId, "ambiguous", "", "", `multiple linked branches: ${names}`);
            throw new ScriptError(`multiple linked branches: ${names}`);
        }

        // Resolution tier 2 — CONNECTED_EVENT open PRs
        // subject is optional (non-PR ConnectedEvent subjects return {}); filter those out
        const openPrs = issue.timelineItems.nodes.filter((n) => n.subject?.state === "OPEN");

        if (openPrs.length === 0) {
            this.emitResult(issueId, "main", "", "", "");
            return;
        }
        if (openPrs.length === 1) {
            const pr = openPrs[0].subject;
            this.emitResult(issueId, "feature_branch", pr?.headRefName ?? "", String(pr?.number), "");
            return;
        }

        const branches = openPrs.map((n) => n.subject?.headRefName).join(", ");
        this.emitResult(issueId, "ambiguous", "", "", `multiple open PRs with branches: ${branches}`);
        throw new ScriptError(`multiple open PRs with branches: ${branches}`);
    }

    private emitResult(issueId: string, status: Status, branch: string, pr: string, details: string): void {
        const result: ResolveResult = {
            issue_id: issueId,
            status,
            branch,
            pr,
            details,
        };
        this.deps.stdio.stdout.write(`${JSON.stringify(result)}\n`);
    }
}

if (import.meta.main) process.exit(await new ResolveIssueBranchScript(defaultDeps).run(process.argv));
