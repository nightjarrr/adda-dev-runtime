// Shared GitHub types, helpers, and errors for all ADDA runtime scripts.
import type { EnvDep } from "./capabilities";
import { ScriptError } from "./errors";

// --- Error types ---

export type GithubReason = "repo_not_found" | "issue_not_found" | "pr_not_found" | "thread_not_found" | "not_a_thread";

// --- Issue descriptor ---

export interface GitHubIssueHeader {
    number: number;
    title: string;
    state: "open" | "closed";
    type: string | null; // first label matching feature|bug|chore|docs
    phase: string | null; // first label starting with "phase: "
    parent: number | null; // parent issue number; null if root
    labels: string[]; // all label names verbatim
    owner: string; // GitHub owner (org or user)
    repo: string; // GitHub repository name
}

// --- Label extraction helpers (internal) ---

const TYPE_LABEL_SET = new Set(["feature", "bug", "chore", "docs"]);

function extractTypeLabel(labels: string[]): string | null {
    return labels.find((l) => TYPE_LABEL_SET.has(l)) ?? null;
}

function extractPhaseLabel(labels: string[]): string | null {
    return labels.find((l) => l.startsWith("phase: ")) ?? null;
}

// --- Factory ---

/**
 * Builds a GitHubIssueHeader from raw API response data.
 * Normalizes state casing, extracts type/phase from labels, and assigns parent.
 */
export function buildIssueHeader(raw: {
    number: number;
    title: string;
    state: string;
    labels: Array<{ name: string }>;
    parent?: number;
    owner: string;
    repo: string;
}): GitHubIssueHeader {
    const labelNames = raw.labels.map((l) => l.name);
    return {
        number: raw.number,
        title: raw.title,
        state: raw.state.toLowerCase() === "closed" ? "closed" : "open",
        type: extractTypeLabel(labelNames),
        phase: extractPhaseLabel(labelNames),
        parent: raw.parent ?? null,
        labels: labelNames,
        owner: raw.owner,
        repo: raw.repo,
    };
}

// --- URL parsing helpers ---

/**
 * Parses a GitHub API repository URL of the form
 * "https://api.github.com/repos/{owner}/{repo}" and returns {owner, repo}.
 * Throws ScriptError("validation_error", ...) on malformed URL.
 */
export function parseRepositoryUrl(url: string): { owner: string; repo: string } {
    const match = /^https:\/\/api\.github\.com\/repos\/([^/]+)\/([^/]+)\/?$/.exec(url);
    if (!match) {
        throw new ScriptError("validation_error", `malformed repository URL: ${url}`);
    }
    return { owner: match[1]!, repo: match[2]! };
}

// --- Env helpers ---

export function requireOwnerRepo(deps: EnvDep): { owner: string; repo: string } {
    const owner = deps.env.get("GITHUB_OWNER");
    if (!owner) throw new ScriptError("missing_env", "required environment variable 'GITHUB_OWNER' is not set");
    const repo = deps.env.get("GITHUB_REPO");
    if (!repo) throw new ScriptError("missing_env", "required environment variable 'GITHUB_REPO' is not set");
    return { owner, repo };
}
