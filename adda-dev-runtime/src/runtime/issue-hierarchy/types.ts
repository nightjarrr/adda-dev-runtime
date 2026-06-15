// Types shared across issue-hierarchy modules.
import type { BaseReason, GithubReason } from "@adda/lib";
import { ScriptError } from "@adda/lib";

// --- Error types ---

export type IssueHierarchyReason = BaseReason | GithubReason;

export class IssueHierarchyError extends ScriptError<IssueHierarchyReason> {}

// --- Issue descriptor ---

export interface IssueHeader {
    number: number;
    title: string;
    state: "open" | "closed";
    type: string | null; // first label matching feature|bug|chore|docs
    phase: string | null; // first label starting with "phase: "
    parent: number | null; // parent issue number; null if root
}

// --- Arg types ---

export type IssueHierarchyArgs = { subcommand: "children"; parentNumber: number };

// --- Result types ---

export type ChildrenResult = { parent: number; children: IssueHeader[] };
