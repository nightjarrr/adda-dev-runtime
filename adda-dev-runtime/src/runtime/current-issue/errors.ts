import { ScriptStructuredError } from "@adda/lib";

export class CurrentIssueError extends ScriptStructuredError {
    constructor(message: string, verboseStderr?: string, details?: Record<string, unknown>) {
        super({ status: "error", issue: null, details: details ?? {}, error: message }, message, 1, verboseStderr);
        this.name = "CurrentIssueError";
    }
}

export class CurrentIssueArgsError extends ScriptStructuredError {
    constructor(message: string) {
        super({ status: "error", issue: null, details: {}, error: message }, message, 2);
        this.name = "CurrentIssueArgsError";
    }
}
