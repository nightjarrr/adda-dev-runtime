// Typed error for pr-review-threads: carries a structured reason code and payload.
import { ScriptError } from "@adda/lib";

/**
 * Typed error for pr-review-threads runtime failures.
 *
 * Throw at the source with the appropriate reason code and payload.
 * The single emit path (Output.emitError) reads these fields to build
 * the structured envelope, eliminating all string-matching classification.
 */
export class PrThreadsError extends ScriptError {
    readonly reason: string;
    readonly payload: Record<string, unknown>;

    constructor(reason: string, message: string, payload: Record<string, unknown> = {}, exitCode = 1) {
        super(message, exitCode);
        this.name = "PrThreadsError";
        this.reason = reason;
        this.payload = payload;
    }
}
