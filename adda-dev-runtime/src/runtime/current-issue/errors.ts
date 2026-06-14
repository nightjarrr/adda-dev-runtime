import type { ScriptEnvelope } from "@adda/lib";
import { ScriptStructuredError } from "@adda/lib";

export type CurrentIssueReason =
    | "invalid_args"
    | "missing_env"
    | "dirty_tree"
    | "api_error"
    | "validation_error"
    | "resolve_failed"
    | "ambiguous"
    | "repo_not_found"
    | "issue_not_found"
    | "checkout_failed"
    | "hook_failed"
    | "no_active_issue"
    | "no_current_issue"
    | "no_feature_branch"
    | "branch_mismatch"
    | "branch_create_failed"
    | "shell_error"
    | "unknown_subcommand";

export class CurrentIssueError extends ScriptStructuredError {
    constructor(
        reason: CurrentIssueReason,
        message: string,
        details: Record<string, unknown> = {},
        exitCode = 1,
        verboseStderr?: string,
    ) {
        const envelope: ScriptEnvelope<never> = { status: "fail", result: null, error: { reason, message, details } };
        super(envelope, message, exitCode, verboseStderr);
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
