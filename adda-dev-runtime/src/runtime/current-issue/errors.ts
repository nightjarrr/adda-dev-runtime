import { ScriptStructuredError } from "@adda/lib";

interface CurrentIssueErrorOpts {
    details?: Record<string, unknown>;
    diagnostic?: string;
    verboseStderr?: string;
}

export class CurrentIssueError extends ScriptStructuredError {
    constructor(message: string, opts: CurrentIssueErrorOpts = {}) {
        super(
            { status: "error", issue: null, details: opts.details ?? {}, error: message },
            opts.diagnostic ?? message,
            1,
            opts.verboseStderr,
        );
        this.name = "CurrentIssueError";
    }
}

export class CurrentIssueArgsError extends ScriptStructuredError {
    constructor(message: string) {
        super({ status: "error", issue: null, details: {}, error: message }, message, 2);
        this.name = "CurrentIssueArgsError";
    }
}
