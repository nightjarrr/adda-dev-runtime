import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { ConfigError, ScriptArgsError, ScriptError, ScriptShellError, ScriptZodValidationError } from "./errors";

describe("ScriptError", () => {
    test("stores exit code and message", () => {
        const err = new ScriptError("internal_error", "test message", { exitCode: 7 });
        expect(err.message).toBe("test message");
        expect(err.exitCode).toBe(7);
        expect(err.name).toBe("ScriptError");
        expect(err).toBeInstanceOf(Error);
    });

    test("defaults exit code to 1 when not provided", () => {
        const err = new ScriptError("internal_error", "default code");
        expect(err.exitCode).toBe(1);
    });

    test("throws RangeError when exitCode is 0", () => {
        expect(() => new ScriptError("internal_error", "msg", { exitCode: 0 })).toThrow(RangeError);
    });

    test("verboseStderr is undefined when not provided", () => {
        const err = new ScriptError("internal_error", "msg");
        expect(err.verboseStderr).toBeUndefined();
    });

    test("verboseStderr stores provided value", () => {
        const err = new ScriptError("internal_error", "msg", { verboseStderr: "raw stderr output" });
        expect(err.verboseStderr).toBe("raw stderr output");
    });

    test("carries envelope with status:fail and correct reason and message", () => {
        const err = new ScriptError("api_error", "something went wrong");
        expect(err.envelope.status).toBe("fail");
        expect(err.envelope.result).toBeNull();
        if (err.envelope.status !== "fail") throw new Error("expected fail");
        expect(err.envelope.error.reason).toBe("api_error");
        expect(err.envelope.error.message).toBe("something went wrong");
    });

    test("carries envelope with provided details", () => {
        const err = new ScriptError("api_error", "msg", { details: { foo: "bar" } });
        if (err.envelope.status !== "fail") throw new Error("expected fail");
        expect(err.envelope.error.details).toEqual({ foo: "bar" });
    });

    test("carries envelope with empty details when none provided", () => {
        const err = new ScriptError("internal_error", "msg");
        if (err.envelope.status !== "fail") throw new Error("expected fail");
        expect(err.envelope.error.details).toEqual({});
    });

    test("accepts TExtra reason string", () => {
        const err = new ScriptError<"gates_failed">("gates_failed", "Quality gates failed", { exitCode: 1 });
        expect(err.reason).toBe("gates_failed");
        if (err.envelope.status !== "fail") throw new Error("expected fail");
        expect(err.envelope.error.reason).toBe("gates_failed");
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

    test("carries envelope with reason invalid_args", () => {
        const err = new ScriptArgsError("bad input");
        expect(err.envelope.status).toBe("fail");
        if (err.envelope.status !== "fail") throw new Error("expected fail");
        expect(err.envelope.error.reason).toBe("invalid_args");
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

    test("carries envelope with reason invalid_config", () => {
        const err = new ConfigError("file not found");
        expect(err.envelope.status).toBe("fail");
        if (err.envelope.status !== "fail") throw new Error("expected fail");
        expect(err.envelope.error.reason).toBe("invalid_config");
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

    test("verboseStderr equals raw stderr passed to constructor", () => {
        const rawStderr = "fatal: not a git repository\n";
        const err = new ScriptShellError("git status", 128, "", rawStderr);
        expect(err.verboseStderr).toBe(rawStderr);
    });

    test("carries envelope with reason shell_error", () => {
        const err = new ScriptShellError("git status", 1, "", "");
        expect(err.envelope.status).toBe("fail");
        if (err.envelope.status !== "fail") throw new Error("expected fail");
        expect(err.envelope.error.reason).toBe("shell_error");
    });
});

describe("ScriptZodValidationError", () => {
    function makeZodError(issues: Array<{ path: (string | number)[]; message: string }>): z.ZodError {
        return new z.ZodError(
            issues.map(({ path, message }) => ({
                code: "custom" as const,
                path,
                message,
            })),
        );
    }

    test("is an instance of ScriptError and Error", () => {
        const zodErr = makeZodError([{ path: ["field"], message: "Required" }]);
        const err = new ScriptZodValidationError("ctx", zodErr, null);
        expect(err).toBeInstanceOf(ScriptError);
        expect(err).toBeInstanceOf(Error);
    });

    test("name is 'ScriptZodValidationError'", () => {
        const zodErr = makeZodError([{ path: ["x"], message: "Invalid" }]);
        const err = new ScriptZodValidationError("ctx", zodErr, null);
        expect(err.name).toBe("ScriptZodValidationError");
    });

    test("message is short summary: context, issue paths, and messages — no raw input", () => {
        const zodErr = makeZodError([{ path: ["data", "id"], message: "Expected number" }]);
        const raw = { data: { id: "notanumber" } };
        const err = new ScriptZodValidationError("API response", zodErr, raw);
        expect(err.message).toContain("API response");
        expect(err.message).toContain("data.id");
        expect(err.message).toContain("Expected number");
        expect(err.message).not.toContain("raw data:");
    });

    test("verboseStderr contains raw input serialized as JSON", () => {
        const zodErr = makeZodError([{ path: ["data", "id"], message: "Expected number" }]);
        const raw = { data: { id: "notanumber" } };
        const err = new ScriptZodValidationError("API response", zodErr, raw);
        expect(err.verboseStderr).toContain("raw data:");
        expect(err.verboseStderr).toContain(JSON.stringify(raw));
    });

    test("verboseStderr is always a string (rawInput is required)", () => {
        const zodErr = makeZodError([{ path: ["name"], message: "Required" }]);
        const err = new ScriptZodValidationError("ctx", zodErr, null);
        expect(typeof err.verboseStderr).toBe("string");
    });

    test("short field does not exist on ScriptZodValidationError", () => {
        const zodErr = makeZodError([{ path: ["x"], message: "bad" }]);
        const err = new ScriptZodValidationError("ctx", zodErr, null);
        expect(err).not.toHaveProperty("short");
    });

    test("multiple issues are all present in message", () => {
        const zodErr = makeZodError([
            { path: ["a"], message: "Missing a" },
            { path: ["b"], message: "Missing b" },
        ]);
        const err = new ScriptZodValidationError("ctx", zodErr, null);
        expect(err.message).toContain("a: Missing a");
        expect(err.message).toContain("b: Missing b");
    });

    test("root-level issue (empty path) is rendered as '(root)'", () => {
        const zodErr = makeZodError([{ path: [], message: "Expected object" }]);
        const err = new ScriptZodValidationError("ctx", zodErr, null);
        expect(err.message).toContain("(root): Expected object");
    });

    test("verboseStderr contains raw input verbatim as JSON", () => {
        const raw = [1, 2, 3];
        const zodErr = makeZodError([{ path: ["0"], message: "Bad" }]);
        const err = new ScriptZodValidationError("ctx", zodErr, raw);
        expect(err.verboseStderr).toContain(`raw data:\n\n${JSON.stringify(raw)}`);
    });

    test("exitCode is 1 (inherited from ScriptError default)", () => {
        const zodErr = makeZodError([{ path: ["x"], message: "bad" }]);
        const err = new ScriptZodValidationError("ctx", zodErr, null);
        expect(err.exitCode).toBe(1);
    });

    test("carries envelope with reason validation_error", () => {
        const zodErr = makeZodError([{ path: ["x"], message: "bad" }]);
        const err = new ScriptZodValidationError("ctx", zodErr, null);
        expect(err.envelope.status).toBe("fail");
        if (err.envelope.status !== "fail") throw new Error("expected fail");
        expect(err.envelope.error.reason).toBe("validation_error");
    });
});
