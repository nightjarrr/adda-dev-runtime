import { describe, expect, test } from "bun:test";
import { ConfigError, ScriptArgsError, ScriptError, ScriptShellError } from "./errors";

describe("ScriptError", () => {
    test("stores exit code and message", () => {
        const err = new ScriptError("test message", 7);
        expect(err.message).toBe("test message");
        expect(err.exitCode).toBe(7);
        expect(err.name).toBe("ScriptError");
        expect(err).toBeInstanceOf(Error);
    });

    test("defaults exit code to 1 when not provided", () => {
        const err = new ScriptError("default code");
        expect(err.exitCode).toBe(1);
    });

    test("throws RangeError when exitCode is 0", () => {
        expect(() => new ScriptError("msg", 0)).toThrow(RangeError);
    });
});

describe("ScriptArgsError", () => {
    test("is an instance of ScriptError", () => {
        const err = new ScriptArgsError("bad input");
        expect(err).toBeInstanceOf(ScriptError);
    });

    test("always has exit code 2", () => {
        const err = new ScriptArgsError("bad input");
        expect(err.exitCode).toBe(2);
    });

    test("prefixes message with 'Invalid arguments:'", () => {
        const err = new ScriptArgsError("bad input");
        expect(err.message).toBe("Invalid arguments: bad input");
    });

    test("name is 'ScriptArgsError'", () => {
        const err = new ScriptArgsError("bad input");
        expect(err.name).toBe("ScriptArgsError");
    });
});

describe("ConfigError", () => {
    test("is an instance of ScriptError", () => {
        const err = new ConfigError("file not found");
        expect(err).toBeInstanceOf(ScriptError);
    });

    test("always has exit code 2", () => {
        const err = new ConfigError("file not found");
        expect(err.exitCode).toBe(2);
    });

    test("prefixes message with 'Config error:'", () => {
        const err = new ConfigError("file not found");
        expect(err.message).toBe("Config error: file not found");
    });

    test("name is 'ConfigError'", () => {
        const err = new ConfigError("file not found");
        expect(err.name).toBe("ConfigError");
    });
});

describe("ScriptShellError", () => {
    test("is an instance of ScriptError and Error", () => {
        const err = new ScriptShellError("echo hello", 1, "", "");
        expect(err).toBeInstanceOf(ScriptError);
        expect(err).toBeInstanceOf(Error);
    });

    test("exitCode is always 1", () => {
        const err = new ScriptShellError("echo hello", 42, "", "");
        expect(err.exitCode).toBe(1);
    });

    test("name is 'ScriptShellError'", () => {
        const err = new ScriptShellError("echo hello", 1, "", "");
        expect(err.name).toBe("ScriptShellError");
    });

    test("message contains 'shell command failed (exit N)'", () => {
        const err = new ScriptShellError("echo hello", 127, "", "");
        expect(err.message).toContain("shell command failed (exit 127)");
    });

    test("message contains 'cmd:' field", () => {
        const err = new ScriptShellError("my-cmd --flag", 1, "", "");
        expect(err.message).toContain("cmd:");
        expect(err.message).toContain("my-cmd --flag");
    });

    test("message contains 'stdout:' field", () => {
        const err = new ScriptShellError("cmd", 1, "some output", "");
        expect(err.message).toContain("stdout:");
    });

    test("message contains 'stderr:' field", () => {
        const err = new ScriptShellError("cmd", 1, "", "some error");
        expect(err.message).toContain("stderr:");
    });

    test("empty stdout renders as '(empty)'", () => {
        const err = new ScriptShellError("cmd", 1, "", "error text");
        expect(err.message).toContain("stdout: (empty)");
    });

    test("empty stderr renders as '(empty)'", () => {
        const err = new ScriptShellError("cmd", 1, "output text", "");
        expect(err.message).toContain("stderr: (empty)");
    });

    test("whitespace-only stdout renders as '(empty)'", () => {
        const err = new ScriptShellError("cmd", 1, "   \n  ", "");
        expect(err.message).toContain("stdout: (empty)");
    });

    test("non-empty stdout is rendered trimmed", () => {
        const err = new ScriptShellError("cmd", 1, "  hello world  ", "");
        expect(err.message).toContain("stdout: hello world");
    });

    test("non-empty stderr is rendered trimmed", () => {
        const err = new ScriptShellError("cmd", 1, "", "  fatal: error  ");
        expect(err.message).toContain("stderr: fatal: error");
    });
});
