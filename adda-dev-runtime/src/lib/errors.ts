import type { z } from "zod";

export class ScriptError extends Error {
    readonly exitCode: number;

    constructor(message: string, exitCode = 1) {
        super(message);
        if (exitCode < 1) throw new RangeError(`ScriptError exitCode must be >= 1, got ${exitCode}`);
        this.name = "ScriptError";
        this.exitCode = exitCode;
    }
}

export class ScriptArgsError extends ScriptError {
    constructor(details: string) {
        super(`Invalid arguments: ${details}`, 2);
        this.name = "ScriptArgsError";
    }
}

export class ConfigError extends ScriptError {
    constructor(details: string) {
        super(`Config error: ${details}`, 2);
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
        );
        this.name = "ScriptShellError";
    }
}

export class ScriptZodValidationError extends ScriptError {
    readonly short: string;

    constructor(context: string, error: z.ZodError, rawInput?: unknown) {
        const issues = error.issues.map((i) => `${i.path.length > 0 ? i.path.join(".") : "(root)"}: ${i.message}`).join("; ");
        const raw = rawInput !== undefined ? `\nraw data:\n\n${JSON.stringify(rawInput)}` : "";
        super(`${context}: ${issues}${raw}`);
        this.short = `${context}: ${issues}`;
        this.name = "ScriptZodValidationError";
    }
}
