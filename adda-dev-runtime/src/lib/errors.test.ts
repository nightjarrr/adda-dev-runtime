import { describe, expect, test } from "bun:test";
import { ConfigError, ScriptArgsError, ScriptError } from "./errors";

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
