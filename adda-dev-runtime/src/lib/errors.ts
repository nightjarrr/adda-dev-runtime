import type { z } from "zod";
import type { ScriptEnvelope } from "./envelope";

export type BaseReason =
    | "invalid_args"
    | "invalid_config"
    | "missing_env"
    | "api_error"
    | "validation_error"
    | "shell_error"
    | "internal_error";

export class ScriptError extends Error {
    readonly exitCode: number;
    readonly reason: string;
    readonly payload: Record<string, unknown>;
    readonly verboseStderr?: string;

    constructor(
        message: string,
        exitCode = 1,
        reason = "internal_error",
        payload: Record<string, unknown> = {},
        verboseStderr?: string,
    ) {
        super(message);
        if (exitCode < 1) throw new RangeError(`ScriptError exitCode must be >= 1, got ${exitCode}`);
        this.name = "ScriptError";
        this.exitCode = exitCode;
        this.reason = reason;
        this.payload = payload;
        this.verboseStderr = verboseStderr;
    }
}

export class ScriptStructuredError extends ScriptError {
    readonly envelope: ScriptEnvelope<never>;

    constructor(
        reason: string,
        message: string,
        {
            details = {},
            exitCode = 1,
            verboseStderr,
        }: { details?: Record<string, unknown>; exitCode?: number; verboseStderr?: string } = {},
    ) {
        super(message, exitCode, reason, {}, verboseStderr);
        this.name = "ScriptStructuredError";
        this.envelope = { status: "fail", result: null, error: { reason, message, details } };
    }
}

export class ScriptArgsError extends ScriptError {
    constructor(details: string) {
        super(`Invalid arguments: ${details}`, 2, "invalid_args");
        this.name = "ScriptArgsError";
    }
}

export class ConfigError extends ScriptError {
    constructor(details: string) {
        super(`Config error: ${details}`, 2, "invalid_config");
        this.name = "ConfigError";
    }
}

export class ScriptShellError extends ScriptError {
    constructor(cmdline: string, shellExitCode: number, stdout: string, stderr: string) {
        const stdoutText = stdout.trim() || "(empty)";
        const stderrText = stderr.trim() || "(empty)";
        super(
            `shell command failed (exit ${shellExitCode})\n  cmd:    ${cmdline}\n  stdout: ${stdoutText}\n  stderr: ${stderrText}`,
            1,
            "shell_error",
            {},
            stderr,
        );
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
        super(shortSummary, 1, "validation_error", {}, verboseStderr);
        this.verboseStderr = verboseStderr;
        this.name = "ScriptZodValidationError";
    }
}
