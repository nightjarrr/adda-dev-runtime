import type { z } from "zod";
import type { ScriptEnvelope } from "./envelope";

export type BaseReason =
    | "invalid_args"
    | "invalid_config"
    | "missing_env"
    | "api_error"
    | "validation_error"
    | "shell_error"
    | "internal_error"
    | "ambiguous_result";

export class ScriptError<TExtra extends string = never> extends Error {
    readonly exitCode: number;
    readonly reason: BaseReason | TExtra;
    readonly envelope: ScriptEnvelope<never, BaseReason | TExtra>;
    readonly verboseStderr?: string;

    constructor(
        reason: BaseReason | TExtra,
        message: string,
        {
            details = {},
            exitCode = 1,
            verboseStderr,
        }: { details?: Record<string, unknown>; exitCode?: number; verboseStderr?: string } = {},
    ) {
        super(message);
        if (exitCode < 1) throw new RangeError(`ScriptError exitCode must be >= 1, got ${exitCode}`);
        this.name = "ScriptError";
        this.exitCode = exitCode;
        this.reason = reason;
        this.envelope = { status: "fail", result: null, error: { reason, message, details } };
        this.verboseStderr = verboseStderr;
    }
}

export class ScriptArgsError extends ScriptError {
    constructor(details: string) {
        super("invalid_args", `Invalid arguments: ${details}`, { exitCode: 2 });
        this.name = "ScriptArgsError";
    }
}

export class ConfigError extends ScriptError {
    constructor(details: string) {
        super("invalid_config", `Config error: ${details}`, { exitCode: 2 });
        this.name = "ConfigError";
    }
}

const STDERR_TRUNCATE_LIMIT = 500;

export class ScriptShellError extends ScriptError {
    constructor(cmdline: string, shellExitCode: number, stdout: string, stderr: string) {
        const truncatedStderr = stderr.length > STDERR_TRUNCATE_LIMIT ? stderr.slice(0, STDERR_TRUNCATE_LIMIT) : stderr;
        const stderrTruncated = stderr.length > STDERR_TRUNCATE_LIMIT;
        const details: Record<string, unknown> = {
            cmd: cmdline,
            exitCode: shellExitCode,
            stdout: stdout.trim() || "(empty)",
            stderr: truncatedStderr.trim() || "(empty)",
        };
        if (stderrTruncated) details.stderrTruncated = true;
        super("shell_error", "shell command failed", { exitCode: 1, details, verboseStderr: stderr });
        this.name = "ScriptShellError";
    }
}

export class ScriptZodValidationError extends ScriptError {
    override readonly verboseStderr: string;

    constructor(context: string, error: z.ZodError, rawInput: unknown) {
        const issues = error.issues.map((i) => `${i.path.length > 0 ? i.path.join(".") : "(root)"}: ${i.message}`).join("; ");
        const raw = `\nraw data:\n\n${JSON.stringify(rawInput)}`;
        const shortSummary = `${context}: ${issues}`;
        const verboseStderr = `${shortSummary}${raw}`;
        super("validation_error", shortSummary, { exitCode: 1, verboseStderr });
        this.verboseStderr = verboseStderr;
        this.name = "ScriptZodValidationError";
    }
}
