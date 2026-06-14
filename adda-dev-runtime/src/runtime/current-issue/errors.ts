import type { ScriptEnvelope } from "@adda/lib";
import { ScriptStructuredError } from "@adda/lib";

import type { ResolveReason } from "../resolve-issue-branch";

export type CurrentIssueReason =
    | ResolveReason
    | "dirty_tree"
    | "resolve_failed"
    | "checkout_failed"
    | "hook_failed"
    | "no_active_issue"
    | "no_current_issue"
    | "no_feature_branch"
    | "branch_mismatch"
    | "branch_create_failed";

export class CurrentIssueError extends ScriptStructuredError {
    constructor(reason: CurrentIssueReason, message: string);
    constructor(reason: CurrentIssueReason, message: string, verboseStderr: string);
    constructor(reason: CurrentIssueReason, message: string, details: Record<string, unknown>);
    constructor(reason: CurrentIssueReason, message: string, details: Record<string, unknown>, verboseStderr: string);
    constructor(
        reason: CurrentIssueReason,
        message: string,
        detailsOrVerbose?: Record<string, unknown> | string,
        verboseStderr?: string,
    ) {
        const details = typeof detailsOrVerbose === "object" ? detailsOrVerbose : {};
        const verbose = typeof detailsOrVerbose === "string" ? detailsOrVerbose : verboseStderr;
        const envelope: ScriptEnvelope<never> = { status: "fail", result: null, error: { reason, message, details } };
        super(envelope, message, 1, verbose);
        this.name = "CurrentIssueError";
    }
}

export class CurrentIssueArgsError extends ScriptStructuredError {
    constructor(message: string) {
        const envelope: ScriptEnvelope<never> = {
            status: "fail",
            result: null,
            error: { reason: "invalid_args", message, details: {} },
        };
        super(envelope, message, 2);
        this.name = "CurrentIssueArgsError";
    }
}
