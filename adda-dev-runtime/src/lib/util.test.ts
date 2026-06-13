import { describe, expect, mock, spyOn, test } from "bun:test";
import type { FileSysDep, FileWriterDep, TmpDep } from "./capabilities";
import { ScriptError } from "./errors";
import { atomicWriteFile, parseJson, slugify } from "./util";

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

describe("slugify", () => {
    test("normal title with spaces becomes hyphenated lowercase", () => {
        expect(slugify("Branch lifecycle tooling for SDLC roles")).toBe("branch-lifecycle-tooling-for-sdlc-roles");
    });

    test("special chars are collapsed to a single hyphen", () => {
        expect(slugify("feat: add #new/feature!")).toBe("feat-add-new-feature");
    });

    test("leading special chars are stripped", () => {
        expect(slugify("---hello world")).toBe("hello-world");
    });

    test("trailing special chars are stripped", () => {
        expect(slugify("hello world---")).toBe("hello-world");
    });

    test("consecutive special chars collapse to single hyphen", () => {
        expect(slugify("hello   ///   world")).toBe("hello-world");
    });

    test("all non-alphanumeric input returns empty string", () => {
        expect(slugify("😀🎉✨")).toBe("");
    });

    test("already slug-like input is unchanged", () => {
        expect(slugify("hello-world")).toBe("hello-world");
    });

    test("numeric-only title is preserved", () => {
        expect(slugify("12345")).toBe("12345");
    });
});

// --- atomicWriteFile ---

type AtomicWriteFileDeps = TmpDep & FileWriterDep & FileSysDep;

function makeAtomicWriteFileDeps(tmpDirValue = "/tmp"): {
    deps: AtomicWriteFileDeps;
    writtenFiles: Map<string, string>;
    renamedFiles: Array<{ from: string; to: string }>;
} {
    const writtenFiles = new Map<string, string>();
    const renamedFiles: Array<{ from: string; to: string }> = [];
    const deps: AtomicWriteFileDeps = {
        tmp: {
            tmpDir: mock(() => tmpDirValue),
            tempFilePath: mock((p = "tmp", s = "") => `${tmpDirValue}/${p}-uuid${s}`),
            makeTempDir: mock(() => `${tmpDirValue}/dir`),
        },
        fileWriter: {
            writeFile: mock(async (path: string, content: string): Promise<void> => {
                writtenFiles.set(path, content);
            }),
        },
        fileSys: {
            renameFile: mock(async (from: string, to: string): Promise<void> => {
                renamedFiles.push({ from, to });
            }),
            deleteFile: mock(async () => {}),
            fileExists: mock(async () => false),
        },
    };
    return { deps, writtenFiles, renamedFiles };
}

describe("atomicWriteFile", () => {
    test("static path (no placeholders): file written at exact path, returns it", async () => {
        const { deps, writtenFiles, renamedFiles } = makeAtomicWriteFileDeps();
        const result = await atomicWriteFile(deps, "/some/dir/file.json", "content");
        expect(result).toBe("/some/dir/file.json");
        expect(renamedFiles).toHaveLength(1);
        expect(renamedFiles[0]!.to).toBe("/some/dir/file.json");
        expect(writtenFiles.size).toBe(1);
    });

    test("<tmpDir> placeholder is expanded to deps.tmp.tmpDir()", async () => {
        const { deps, renamedFiles } = makeAtomicWriteFileDeps("/custom/tmp");
        const result = await atomicWriteFile(deps, "<tmpDir>/out.json", "data");
        expect(result).toBe("/custom/tmp/out.json");
        expect(renamedFiles[0]!.to).toBe("/custom/tmp/out.json");
    });

    test("<ts> placeholder is expanded to a numeric string", async () => {
        const { deps, renamedFiles } = makeAtomicWriteFileDeps();
        const result = await atomicWriteFile(deps, "/tmp/file-<ts>.json", "data");
        // Extract the timestamp portion
        const match = /^\/tmp\/file-(\d+)\.json$/.exec(result);
        expect(match).not.toBeNull();
        expect(Number(match![1])).toBeGreaterThan(0);
        expect(renamedFiles[0]!.to).toBe(result);
    });

    test("<uuid> placeholder is expanded to a UUID-format string", async () => {
        const { deps, renamedFiles } = makeAtomicWriteFileDeps();
        const result = await atomicWriteFile(deps, "/tmp/file-<uuid>.json", "data");
        const match = /^\/tmp\/file-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/i.exec(result);
        expect(match).not.toBeNull();
        expect(renamedFiles[0]!.to).toBe(result);
    });

    test("temp file is created in same directory as final path", async () => {
        const { deps, writtenFiles, renamedFiles } = makeAtomicWriteFileDeps();
        await atomicWriteFile(deps, "/some/dir/output.json", "data");
        const tmpPath = [...writtenFiles.keys()][0]!;
        expect(tmpPath.startsWith("/some/dir/")).toBe(true);
        expect(tmpPath).not.toBe("/some/dir/output.json");
        expect(renamedFiles[0]!.from).toBe(tmpPath);
    });

    test("content is written to the temp file", async () => {
        const { deps, writtenFiles } = makeAtomicWriteFileDeps();
        await atomicWriteFile(deps, "/tmp/out.json", "hello world");
        const content = [...writtenFiles.values()][0]!;
        expect(content).toBe("hello world");
    });

    test("returns the resolved final path", async () => {
        const { deps } = makeAtomicWriteFileDeps("/my/tmp");
        const result = await atomicWriteFile(deps, "<tmpDir>/prefix-<ts>.json", "x");
        expect(result.startsWith("/my/tmp/prefix-")).toBe(true);
        expect(result.endsWith(".json")).toBe(true);
    });
});
