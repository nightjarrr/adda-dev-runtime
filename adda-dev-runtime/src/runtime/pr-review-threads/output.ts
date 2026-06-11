// Output helpers for pr-review-threads: envelope emission, error classification, detail file write.
import type { FileWriterDep, FileSysDep, StdioDep, TmpDep } from "@adda/lib";
import { ConfigError } from "@adda/lib";
import type { Envelope } from "./types";

// --- Reason codes ---

const REASON_MISSING_ENV = "missing_env";
const REASON_INVALID_CONFIG = "invalid_config";
const REASON_GRAPHQL_ERROR = "graphql_error";
const REASON_INTERNAL_ERROR = "internal_error";

/**
 * Classify an unhandled error into a short reason code for the structured envelope.
 */
export function classifyError(err: unknown): string {
    if (err instanceof ConfigError) return REASON_INVALID_CONFIG;
    if (err instanceof Error) {
        if (err.message.startsWith("required environment variable")) return REASON_MISSING_ENV;
        if (err.message.startsWith("GraphQL API call failed")) return REASON_GRAPHQL_ERROR;
    }
    return REASON_INTERNAL_ERROR;
}

type OutputDeps = StdioDep & TmpDep & FileWriterDep & FileSysDep;

/**
 * Owns all envelope emission for a single pr-review-threads invocation.
 *
 * The `envelopeEmitted` guard ensures exactly one envelope is written to stdout
 * even when an error is both explicitly handled and caught by the outer catch.
 */
export class Output {
    private envelopeEmitted = false;

    constructor(private readonly deps: OutputDeps) {}

    get hasEmitted(): boolean {
        return this.envelopeEmitted;
    }

    emitSuccess(envelope: Envelope): void {
        this.deps.stdio.stdout.write(`${JSON.stringify(envelope)}\n`);
        this.envelopeEmitted = true;
    }

    /**
     * Emit a keyless structured error envelope (for pre-dispatch / arg validation errors).
     * Shape: { "status": "error", "error": "<message>" }
     */
    emitKeylessError(message: string): void {
        const envelope: { status: "error"; error: string } = { status: "error", error: message };
        this.deps.stdio.stdout.write(`${JSON.stringify(envelope)}\n`);
        this.envelopeEmitted = true;
    }

    /**
     * Emit a mode-keyed structured error envelope.
     * Shape for pr:     { "status": "error", "error": "<message>", "pr":     { "reason": "<code>", … } }
     * Shape for thread: { "status": "error", "error": "<message>", "thread": { "reason": "<code>", … } }
     */
    emitModeError(mode: "pr", reason: string, message: string): void;
    emitModeError(mode: "thread", reason: string, message: string): void;
    emitModeError(mode: "pr" | "thread", reason: string, message: string): void {
        let envelope: Envelope;
        if (mode === "pr") {
            envelope = { status: "error", error: message, pr: { reason } };
        } else {
            envelope = { status: "error", error: message, thread: { reason } };
        }
        this.deps.stdio.stdout.write(`${JSON.stringify(envelope)}\n`);
        this.envelopeEmitted = true;
    }

    emitScanLimitExceeded(
        mode: "pr" | "thread",
        total: number | undefined,
        commentCount: number | undefined,
        ceiling: number,
    ): void {
        let envelope: Envelope;
        if (mode === "pr") {
            const message = `scan limit exceeded: ${total} threads > ceiling ${ceiling}`;
            envelope = { status: "error", error: message, pr: { reason: "scan_limit_exceeded", total, ceiling } };
        } else {
            const message = `scan limit exceeded: ${commentCount} comments > ceiling ${ceiling}`;
            envelope = {
                status: "error",
                error: message,
                thread: { reason: "scan_limit_exceeded", commentCount, ceiling },
            };
        }
        this.deps.stdio.stdout.write(`${JSON.stringify(envelope)}\n`);
        this.envelopeEmitted = true;
    }

    /**
     * Atomically writes a detail file to /tmp using write-then-rename.
     * Returns the final file path.
     */
    async writeDetailFile<T>(prefix: string, content: T): Promise<string> {
        const epoch = Date.now();
        const finalPath = `${this.deps.tmp.tmpDir()}/${prefix}-${epoch}.json`;
        const tmpPath = this.deps.tmp.tempFilePath("pr-review-threads-tmp", ".json");
        await this.deps.fileWriter.writeFile(tmpPath, JSON.stringify(content, null, 2));
        await this.deps.fileSys.renameFile(tmpPath, finalPath);
        return finalPath;
    }
}
