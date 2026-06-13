// Structured error types for pr-review-threads.
import { ScriptError, ScriptStructuredError } from "@adda/lib";

export class PrThreadsModeError extends ScriptStructuredError {
    constructor(mode: "pr" | "thread", cause: unknown) {
        const message = cause instanceof Error ? cause.message : String(cause);
        const exitCode = cause instanceof ScriptError ? cause.exitCode : 1;
        const reason = cause instanceof ScriptError ? cause.reason : "internal_error";
        const payload = cause instanceof ScriptError ? cause.payload : {};

        const envelope =
            mode === "pr"
                ? { status: "error", error: message, pr: { reason, ...payload } }
                : { status: "error", error: message, thread: { reason, ...payload } };

        super(envelope, message, exitCode);
        this.name = "PrThreadsModeError";
    }
}

export async function runMode(mode: "pr" | "thread", inner: () => Promise<void>): Promise<void> {
    try {
        await inner();
    } catch (err) {
        throw new PrThreadsModeError(mode, err);
    }
}
