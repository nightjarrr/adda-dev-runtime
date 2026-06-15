// Types shared across issue-hierarchy modules.
import type { BaseReason, GithubReason, GitHubIssueHeader } from "@adda/lib";
import { ScriptError } from "@adda/lib";

// --- Error types ---

export type IssueHierarchyReason = BaseReason | GithubReason;

export class IssueHierarchyError extends ScriptError<IssueHierarchyReason> {}

// --- Arg types ---

export type IssueHierarchyArgs =
    | { subcommand: "children"; parentNumber: number }
    | { subcommand: "parent"; issueNumber: number; setParent?: number | null }
    | { subcommand: "siblings"; issueNumber: number };

// --- Result types ---

export type ChildrenResult = { parent: number; children: GitHubIssueHeader[] };
export type ParentResult = { issue: number; parent: GitHubIssueHeader | null };
export type SiblingsResult = { issue: number; siblings: GitHubIssueHeader[] };
