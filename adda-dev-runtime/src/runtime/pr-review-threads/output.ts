// Output helpers for pr-review-threads: envelope emission, detail file write.
import type { FileWriterDep, FileSysDep, StdioDep, TmpDep } from "@adda/lib";
import { ConfigError, ScriptArgsError } from "@adda/lib";
import { PrThreadsError } from "./errors";
import type { Envelope } from "./types";

type OutputDeps = StdioDep & TmpDep & FileWriterDep & FileSysDep;

export class Output {
    constructor(private readonly deps: OutputDeps) {}

    emitSuccess(envelope: Envelope): void {
        this.deps.stdio.stdout.write(`${JSON.stringify(envelope)}\n`);
    }

    /**
     * Emit a keyless structured error envelope and throw ScriptArgsError in one call.
     * Shape: { "status": "error", "error": "<message>" }
     * Mirrors current-issue's fail() pattern.
     */
    failKeyless(message: string): never {
        this.emitKeylessError(message);
        throw new ScriptArgsError(message);
    }

    /**
     * Emit a keyless structured error envelope (for pre-dispatch / arg validation errors).
     * Shape: { "status": "error", "error": "<message>" }
     */
    emitKeylessError(message: string): void {
        const envelope: { status: "error"; error: string } = { status: "error", error: message };
        this.deps.stdio.stdout.write(`${JSON.stringify(envelope)}\n`);
    }

    /**
     * Emit a mode-keyed structured error envelope.
     *
     * If err is a PrThreadsError, reads err.reason and err.payload directly.
     * Any other error is treated as internal_error.
     *
     * Shape for pr:     { "status": "error", "error": "<message>", "pr":     { "reason": "<code>", …payload } }
     * Shape for thread: { "status": "error", "error": "<message>", "thread": { "reason": "<code>", …payload } }
     */
    emitError(mode: "pr" | "thread", err: unknown): void {
        const message = err instanceof Error ? err.message : String(err);
        let reason: string;
        let payload: Record<string, unknown>;
        if (err instanceof PrThreadsError) {
            reason = err.reason;
            payload = err.payload;
        } else if (err instanceof ConfigError) {
            reason = "invalid_config";
            payload = {};
        } else {
            reason = "internal_error";
            payload = {};
        }

        let envelope: Envelope;
        if (mode === "pr") {
            envelope = { status: "error", error: message, pr: { reason, ...payload } };
        } else {
            envelope = { status: "error", error: message, thread: { reason, ...payload } };
        }
        this.deps.stdio.stdout.write(`${JSON.stringify(envelope)}\n`);
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

/**
 * Shared wrapper: the single runtime-error emit point.
 *
 * Calls inner(), catches any error, emits the mode-keyed error envelope,
 * and re-throws. runPrInner / runThreadInner stay separate (wrapper-only merge).
 */
export async function runMode(mode: "pr" | "thread", output: Output, inner: () => Promise<void>): Promise<void> {
    try {
        await inner();
    } catch (err) {
        output.emitError(mode, err);
        throw err;
    }
}
