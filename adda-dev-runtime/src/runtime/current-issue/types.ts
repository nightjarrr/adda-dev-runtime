import type { BaseReason, GithubReason } from "@adda/lib";
import { ScriptStructuredError } from "@adda/lib";
import { z } from "zod";

// --- Schemas ---

export const IssueStateSchema = z.object({
    id: z.string(),
    title: z.string(),
    type: z.string(),
    phase: z.string(),
    state: z.enum(["OPEN", "CLOSED"]),
    pr: z.string(),
});

export const GhIssueSchema = z.object({
    title: z.string(),
    labels: z.array(z.object({ name: z.string() })),
    state: z.enum(["OPEN", "CLOSED"]),
});

// --- Types ---

export type IssueState = z.infer<typeof IssueStateSchema>;

export interface IssueStateView {
    id: string;
    title: string;
    type: string;
    phase: string;
    state: string;
    pr: string;
}

export const EMPTY_ISSUE_VIEW: IssueStateView = {
    id: "",
    title: "",
    type: "",
    phase: "",
    state: "",
    pr: "",
};

export type HookResult =
    | { status: "ok"; output: string }
    | { status: "failed"; output: string }
    | { status: "skipped" }
    | { status: "absent" };

export type CurrentIssueResult = {
    issue: IssueStateView;
    details: Record<string, unknown>;
};

// --- Error types ---

export type CurrentIssueReason =
    | BaseReason
    | GithubReason
    | "dirty_tree"
    | "checkout_failed"
    | "no_active_issue"
    | "hook_failed"
    | "resolve_failed"
    | "no_current_issue"
    | "branch_mismatch"
    | "branch_create_failed"
    | "no_feature_branch";

export class CurrentIssueError extends ScriptStructuredError<CurrentIssueReason> {}

// --- Interfaces ---

export interface IssueStateStore {
    readState(): Promise<IssueState | null>;
    writeState(state: IssueState): Promise<void>;
    deleteState(): Promise<void>;
    stateExists(): Promise<boolean>;
}
