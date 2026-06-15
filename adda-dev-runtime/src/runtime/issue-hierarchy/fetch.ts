// Fetch helpers for issue-hierarchy: env helpers and sub-issue fetcher.
import type { EnvDep, ShellDep } from "@adda/lib";
import { parseJson, ScriptZodValidationError } from "@adda/lib";
import { z } from "zod";
import { IssueHierarchyError } from "./types";
import type { IssueHeader } from "./types";

// --- Env helpers ---

export function requireOwnerRepo(deps: EnvDep): { owner: string; repo: string } {
    const owner = deps.env.get("GITHUB_OWNER");
    if (!owner) throw new IssueHierarchyError("missing_env", "required environment variable 'GITHUB_OWNER' is not set");
    const repo = deps.env.get("GITHUB_REPO");
    if (!repo) throw new IssueHierarchyError("missing_env", "required environment variable 'GITHUB_REPO' is not set");
    return { owner, repo };
}

// --- Schema ---

const RawSubIssueSchema = z.object({
    number: z.number(),
    title: z.string(),
    state: z.enum(["open", "closed"]),
    labels: z.array(z.object({ name: z.string() })),
});

// --- Label helpers ---

const TYPE_LABELS = new Set(["feature", "bug", "chore", "docs"]);

export function extractTypeLabel(labels: string[]): string | null {
    return labels.find((l) => TYPE_LABELS.has(l)) ?? null;
}

export function extractPhaseLabel(labels: string[]): string | null {
    return labels.find((l) => l.startsWith("phase: ")) ?? null;
}

// --- Fetch ---

export async function fetchChildren(
    deps: ShellDep & EnvDep,
    owner: string,
    repo: string,
    parentNumber: number,
): Promise<IssueHeader[]> {
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
        const parsed = RawSubIssueSchema.safeParse(raw);
        if (!parsed.success) throw new ScriptZodValidationError("unexpected sub_issues response", parsed.error, raw);

        const labelNames = parsed.data.labels.map((l) => l.name);
        return {
            number: parsed.data.number,
            title: parsed.data.title,
            state: parsed.data.state,
            type: extractTypeLabel(labelNames),
            phase: extractPhaseLabel(labelNames),
            parent: parentNumber,
        };
    });
}
