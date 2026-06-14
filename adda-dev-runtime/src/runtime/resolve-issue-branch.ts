import type { parseArgs } from "node:util";
import type { EnvDep, ShellDep, StdioDep } from "@adda/lib";
import { defaultDeps, parseJson, ScriptBase, ScriptZodValidationError } from "@adda/lib";
import type { ScriptEnvelope } from "@adda/lib";
import { ScriptStructuredError } from "@adda/lib";
import { z } from "zod";

type ResolveIssueBranchDeps = ShellDep & EnvDep & StdioDep;

type ResolveIssueBranchArgs = { issueId: string };

type ResolveReason =
    | "invalid_args"
    | "missing_env"
    | "api_error"
    | "repo_not_found"
    | "issue_not_found"
    | "validation_error"
    | "ambiguous";

type ResolveResult = {
    issue_id: string;
    resolution: "feature_branch" | "main";
    branch: string;
    pr: string;
};

class ResolveIssueBranchError extends ScriptStructuredError {
    constructor(
        reason: ResolveReason,
        message: string,
        details: Record<string, unknown> = {},
        exitCode = 1,
        verboseStderr?: string,
    ) {
        const envelope: ScriptEnvelope<never> = { status: "fail", result: null, error: { reason, message, details } };
        super(envelope, message, exitCode, verboseStderr);
        this.name = "ResolveIssueBranchError";
    }
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
            throw new ResolveIssueBranchError("invalid_args", "usage: resolve-issue-branch <issue_id>", {}, 2);
        }
        return { issueId: parsed.positionals[0] };
    }

    protected async execute(args: ResolveIssueBranchArgs): Promise<void> {
        const issueId = args.issueId;

        const owner = this.deps.env.get("GITHUB_OWNER");
        if (!owner) {
            throw new ResolveIssueBranchError("missing_env", "required environment variable 'GITHUB_OWNER' is not set", {
                issueId,
            });
        }

        const repo = this.deps.env.get("GITHUB_REPO");
        if (!repo) {
            throw new ResolveIssueBranchError("missing_env", "required environment variable 'GITHUB_REPO' is not set", {
                issueId,
            });
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
            const message = `GraphQL API call failed: ${ghResult.stderr.trim() || ghResult.stdout.trim()}`;
            throw new ResolveIssueBranchError("api_error", message, { issueId }, 1, ghResult.stderr);
        }

        let raw: unknown;
        try {
            raw = parseJson(ghResult.stdout);
        } catch {
            throw new ResolveIssueBranchError("api_error", "invalid JSON", { issueId });
        }

        const parsed = GraphQLSchema.safeParse(raw);
        if (!parsed.success) {
            const err = new ScriptZodValidationError("unexpected API response", parsed.error, raw);
            throw new ResolveIssueBranchError("validation_error", err.message, { issueId }, 1, err.verboseStderr);
        }

        // Domain conditions — null is intentional (not found), not a schema violation
        if (parsed.data.data.repository === null) {
            throw new ResolveIssueBranchError("repo_not_found", `repository ${owner}/${repo} not found`, { owner, repo });
        }
        if (parsed.data.data.repository.issue === null) {
            throw new ResolveIssueBranchError("issue_not_found", `issue #${issueId} not found in ${owner}/${repo}`, {
                issueId,
                owner,
                repo,
            });
        }

        const issue = parsed.data.data.repository.issue;

        // Resolution tier 1 — linkedBranches
        const linkedNodes = issue.linkedBranches.nodes;
        if (linkedNodes.length === 1) {
            this.emit<ScriptEnvelope<ResolveResult>>({
                status: "ok",
                result: { issue_id: issueId, resolution: "feature_branch", branch: linkedNodes[0].ref.name, pr: "" },
                error: null,
            });
            return;
        }
        if (linkedNodes.length > 1) {
            const names = linkedNodes.map((n) => n.ref.name).join(", ");
            throw new ResolveIssueBranchError("ambiguous", `multiple linked branches: ${names}`, {
                branches: linkedNodes.map((n) => n.ref.name),
            });
        }

        // Resolution tier 2 — CONNECTED_EVENT open PRs
        // subject is optional (non-PR ConnectedEvent subjects return {}); filter those out
        const openPrs = issue.timelineItems.nodes.filter((n) => n.subject?.state === "OPEN");

        if (openPrs.length === 0) {
            this.emit<ScriptEnvelope<ResolveResult>>({
                status: "ok",
                result: { issue_id: issueId, resolution: "main", branch: "", pr: "" },
                error: null,
            });
            return;
        }
        if (openPrs.length === 1) {
            const pr = openPrs[0].subject;
            this.emit<ScriptEnvelope<ResolveResult>>({
                status: "ok",
                result: {
                    issue_id: issueId,
                    resolution: "feature_branch",
                    branch: pr?.headRefName ?? "",
                    pr: String(pr?.number),
                },
                error: null,
            });
            return;
        }

        const branches = openPrs.map((n) => n.subject?.headRefName).join(", ");
        throw new ResolveIssueBranchError("ambiguous", `multiple open PRs with branches: ${branches}`, {
            branches: openPrs.map((n) => n.subject?.headRefName),
        });
    }
}

if (import.meta.main) process.exit(await new ResolveIssueBranchScript(defaultDeps).run(process.argv));
