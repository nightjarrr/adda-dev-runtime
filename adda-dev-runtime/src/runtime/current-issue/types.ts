import type { BaseReason, GithubReason, GitHubIssueHeader } from "@adda/lib";
import { ScriptError } from "@adda/lib";
import { z } from "zod";

// --- Schemas ---

const hierarchyEntrySchema = z.object({
    number: z.number(),
    title: z.string(),
    state: z.enum(["open", "closed"]),
    type: z.string().nullable(),
    phase: z.string().nullable(),
    parent: z.number().nullable(),
    labels: z.array(z.string()),
});

export const IssueStateSchema = z.object({
    id: z.string(),
    title: z.string(),
    type: z.string(),
    phase: z.string(),
    state: z.enum(["OPEN", "CLOSED"]),
    pr: z.string(),
    parent: hierarchyEntrySchema.nullable(),
    children: z.array(hierarchyEntrySchema),
    siblings: z.array(hierarchyEntrySchema),
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
    parent: GitHubIssueHeader | null;
    children: GitHubIssueHeader[];
    siblings: GitHubIssueHeader[];
}

export const EMPTY_ISSUE_VIEW: IssueStateView = {
    id: "",
    title: "",
    type: "",
    phase: "",
    state: "",
    pr: "",
    parent: null,
    children: [],
    siblings: [],
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
    | "no_active_issue"
    | "hook_failed"
    | "no_current_issue"
    | "branch_mismatch"
    | "no_feature_branch";

export class CurrentIssueError extends ScriptError<CurrentIssueReason> {}

// --- Interfaces ---

export interface IssueStateStore {
    readState(): Promise<IssueState | null>;
    writeState(state: IssueState): Promise<void>;
    deleteState(): Promise<void>;
    stateExists(): Promise<boolean>;
}
