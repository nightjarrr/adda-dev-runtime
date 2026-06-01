import { describe, expect, spyOn, test } from "bun:test";
import { ScriptError } from "./errors";
import { parseJson } from "./util";

describe("parseJson", () => {
    test("valid JSON string returns parsed value", () => {
        expect(parseJson('{"id":1,"name":"alice"}')).toEqual({ id: 1, name: "alice" });
    });

    test("valid JSON array returns parsed value", () => {
        expect(parseJson("[1,2,3]")).toEqual([1, 2, 3]);
    });

    test("valid JSON null returns null", () => {
        expect(parseJson("null")).toBeNull();
    });

    test("invalid JSON throws ScriptError, not bare SyntaxError", () => {
        expect(() => parseJson("not-valid-json")).toThrow(ScriptError);
        expect(() => parseJson("not-valid-json")).not.toThrow(SyntaxError);
    });

    test("thrown ScriptError is instanceof ScriptError", () => {
        let caught: unknown;
        try {
            parseJson("{bad");
        } catch (e) {
            caught = e;
        }
        expect(caught).toBeInstanceOf(ScriptError);
    });

    test("ScriptError message contains 'invalid JSON'", () => {
        let caught: unknown;
        try {
            parseJson("{bad");
        } catch (e) {
            caught = e;
        }
        expect((caught as ScriptError).message).toContain("invalid JSON");
    });

    test("ScriptError message contains 'raw data:'", () => {
        let caught: unknown;
        try {
            parseJson("bad input here");
        } catch (e) {
            caught = e;
        }
        expect((caught as ScriptError).message).toContain("raw data:");
    });

    test("ScriptError message contains the raw string", () => {
        const rawString = "definitely not json!";
        let caught: unknown;
        try {
            parseJson(rawString);
        } catch (e) {
            caught = e;
        }
        expect((caught as ScriptError).message).toContain(rawString);
    });

    test("non-SyntaxError is re-thrown as-is", () => {
        const typeError = new TypeError("mock");
        const spy = spyOn(JSON, "parse").mockImplementationOnce(() => {
            throw typeError;
        });
        let caught: unknown;
        try {
            parseJson("{}");
        } catch (e) {
            caught = e;
        }
        spy.mockRestore();
        expect(caught).toBe(typeError);
        expect(caught).toBeInstanceOf(TypeError);
        expect(caught).not.toBeInstanceOf(ScriptError);
    });
});
