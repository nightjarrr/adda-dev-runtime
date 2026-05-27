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
