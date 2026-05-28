import type { parseArgs } from "node:util";
import type { EnvDep, ShellDep, StdioDep } from "@adda/lib";
import { defaultDeps, ScriptArgsError, ScriptBase, ScriptError } from "@adda/lib";

type ResolveIssueBranchDeps = ShellDep & EnvDep & StdioDep;

type Status = "feature_branch" | "main" | "ambiguous" | "error";

interface ResolveResult {
    issue_id: string;
    status: Status;
    branch: string;
    pr: string;
    details: string;
}

interface GraphQLResponse {
    data?: {
        repository?: {
            issue?: {
                linkedBranches?: { nodes?: Array<{ ref: { name: string } }> };
                timelineItems?: {
                    nodes?: Array<{
                        subject: { number: number; state: string; headRefName: string };
                    }>;
                };
            } | null;
        } | null;
    } | null;
}

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

export class ResolveIssueBranchScript extends ScriptBase<ResolveIssueBranchDeps> {
    protected argDefinitions(): Parameters<typeof parseArgs>[0] {
        return { options: {}, allowPositionals: true };
    }

    protected async execute(parsed: ReturnType<typeof parseArgs>): Promise<void> {
        if (parsed.positionals.length !== 1) {
            this.emit("", "error", "", "", "usage: resolve-issue-branch <issue_id>");
            throw new ScriptArgsError("usage: resolve-issue-branch <issue_id>");
        }

        const issueId = parsed.positionals[0];

        const owner = this.deps.env.get("GITHUB_OWNER");
        if (!owner) {
            this.emit(issueId, "error", "", "", "required environment variable 'GITHUB_OWNER' is not set");
            throw new ScriptError("required environment variable 'GITHUB_OWNER' is not set");
        }

        const repo = this.deps.env.get("GITHUB_REPO");
        if (!repo) {
            this.emit(issueId, "error", "", "", "required environment variable 'GITHUB_REPO' is not set");
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
            this.emit(issueId, "error", "", "", details);
            throw new ScriptError(details);
        }

        const response: GraphQLResponse = JSON.parse(ghResult.stdout);

        if (response.data == null) {
            this.emit(issueId, "error", "", "", "unexpected API response: missing data");
            throw new ScriptError("unexpected API response: missing data");
        }
        if (response.data.repository == null) {
            this.emit(issueId, "error", "", "", `repository ${owner}/${repo} not found`);
            throw new ScriptError(`repository ${owner}/${repo} not found`);
        }
        if (response.data.repository.issue == null) {
            this.emit(issueId, "error", "", "", `issue #${issueId} not found in ${owner}/${repo}`);
            throw new ScriptError(`issue #${issueId} not found in ${owner}/${repo}`);
        }

        const issue = response.data.repository.issue;

        if (issue.linkedBranches == null) {
            this.emit(issueId, "error", "", "", "unexpected API response: missing linkedBranches");
            throw new ScriptError("unexpected API response: missing linkedBranches");
        }
        if (issue.linkedBranches.nodes == null) {
            this.emit(issueId, "error", "", "", "unexpected API response: missing linkedBranches.nodes");
            throw new ScriptError("unexpected API response: missing linkedBranches.nodes");
        }
        if (issue.timelineItems == null) {
            this.emit(issueId, "error", "", "", "unexpected API response: missing timelineItems");
            throw new ScriptError("unexpected API response: missing timelineItems");
        }
        if (issue.timelineItems.nodes == null) {
            this.emit(issueId, "error", "", "", "unexpected API response: missing timelineItems.nodes");
            throw new ScriptError("unexpected API response: missing timelineItems.nodes");
        }

        // Resolution tier 1 — linkedBranches
        const linkedNodes = issue.linkedBranches.nodes;
        if (linkedNodes.length === 1) {
            this.emit(issueId, "feature_branch", linkedNodes[0].ref.name, "", "");
            return;
        }
        if (linkedNodes.length > 1) {
            const names = linkedNodes.map((n) => n.ref.name).join(", ");
            this.emit(issueId, "ambiguous", "", "", `multiple linked branches: ${names}`);
            throw new ScriptError(`multiple linked branches: ${names}`);
        }

        // Resolution tier 2 — CONNECTED_EVENT open PRs
        const openPrs = issue.timelineItems.nodes.filter((n) => n.subject.state === "OPEN");

        if (openPrs.length === 0) {
            this.emit(issueId, "main", "", "", "");
            return;
        }
        if (openPrs.length === 1) {
            const pr = openPrs[0].subject;
            this.emit(issueId, "feature_branch", pr.headRefName, String(pr.number), "");
            return;
        }

        const branches = openPrs.map((n) => n.subject.headRefName).join(", ");
        this.emit(issueId, "ambiguous", "", "", `multiple open PRs with branches: ${branches}`);
        throw new ScriptError(`multiple open PRs with branches: ${branches}`);
    }

    private emit(issueId: string, status: Status, branch: string, pr: string, details: string): void {
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
