// Types shared across issue-hierarchy modules.
import { z } from "zod";
import type { BaseReason, GithubReason, GitHubIssueHeader } from "@adda/lib";
import { ScriptError } from "@adda/lib";

// --- Error types ---

export type IssueHierarchyReason = BaseReason | GithubReason;

export class IssueHierarchyError extends ScriptError<IssueHierarchyReason> {}

// --- Schema for raw API response ---

export const RawIssueSchema = z.object({
    number: z.number(),
    title: z.string(),
    state: z.enum(["open", "closed"]),
    labels: z.array(z.object({ name: z.string() })),
});

// --- Arg types ---

export type IssueHierarchyArgs =
    | { subcommand: "children"; parentNumber: number }
    | { subcommand: "parent"; issueNumber: number; setParent?: number | null }
    | { subcommand: "siblings"; issueNumber: number }
    | { subcommand: "orphans"; includeClosed: boolean };

// --- Result types ---

export type ChildrenResult = { parent: number; children: GitHubIssueHeader[] };
export type ParentResult = { issue: number; parent: GitHubIssueHeader | null };
export type SiblingsResult = { issue: number; siblings: GitHubIssueHeader[] };
export type OrphansResult = { orphans: GitHubIssueHeader[] };
