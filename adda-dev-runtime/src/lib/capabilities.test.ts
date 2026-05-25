import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
    BunEnv,
    BunFileReader,
    BunFileWriter,
    BunShell,
    BunStdio,
} from "./capabilities";

// --- BunShell ---

describe("BunShell", () => {
    test("create() returns a BunShell instance", () => {
        const shell = BunShell.create();
        expect(shell).toBeInstanceOf(BunShell);
    });

    test("runs a subprocess and returns stdout and exit code 0", async () => {
        const shell = new BunShell();
        const result = await shell.run(["echo", "hello shell"]);
        expect(result.stdout.trim()).toBe("hello shell");
        expect(result.exitCode).toBe(0);
    });

    test("returns non-zero exit code for failing command", async () => {
        const shell = new BunShell();
        const result = await shell.run(["false"]);
        expect(result.exitCode).not.toBe(0);
    });
});

// --- BunFileReader ---

describe("BunFileReader", () => {
    let tmpDir: string;

    afterEach(async () => {
        if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
    });

    test("create() returns a BunFileReader instance", () => {
        const reader = BunFileReader.create();
        expect(reader).toBeInstanceOf(BunFileReader);
    });

    test("reads file content written to a temp path", async () => {
        tmpDir = await mkdtemp(join(tmpdir(), "adda-test-"));
        const filePath = join(tmpDir, "test.txt");
        await Bun.write(filePath, "file content");

        const reader = new BunFileReader();
        const content = await reader.readFile(filePath);
        expect(content).toBe("file content");
    });
});

// --- BunFileWriter ---

describe("BunFileWriter", () => {
    let tmpDir: string;

    afterEach(async () => {
        if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
    });

    test("create() returns a BunFileWriter instance", () => {
        const writer = BunFileWriter.create();
        expect(writer).toBeInstanceOf(BunFileWriter);
    });

    test("writes content to a temp path and it is readable", async () => {
        tmpDir = await mkdtemp(join(tmpdir(), "adda-test-"));
        const filePath = join(tmpDir, "out.txt");

        const writer = new BunFileWriter();
        await writer.writeFile(filePath, "written content");

        const readBack = await Bun.file(filePath).text();
        expect(readBack).toBe("written content");
    });
});

// --- BunStdio ---

describe("BunStdio", () => {
    test("create() returns a BunStdio instance", () => {
        const stdio = BunStdio.create();
        expect(stdio).toBeInstanceOf(BunStdio);
    });

    test("readLine returns the first line from the input stream", async () => {
        const input = Readable.from(["hello world\n"]);
        const stdio = new BunStdio(input);
        const line = await stdio.readLine();
        expect(line).toBe("hello world");
    });

    test("readLine returns empty string when input stream is empty", async () => {
        const input = Readable.from([]);
        const stdio = new BunStdio(input);
        const line = await stdio.readLine();
        expect(line).toBe("");
    });

    test("writeOut completes without throwing", async () => {
        const stdio = new BunStdio();
        await expect(stdio.writeOut("test output\n")).resolves.toBeUndefined();
    });

    test("writeErr completes without throwing", async () => {
        const stdio = new BunStdio();
        await expect(stdio.writeErr("test error\n")).resolves.toBeUndefined();
    });
});

// --- BunEnv ---

describe("BunEnv", () => {
    test("create() returns a BunEnv instance", () => {
        const env = BunEnv.create();
        expect(env).toBeInstanceOf(BunEnv);
    });

    test("reads a known environment variable (PATH)", () => {
        const env = new BunEnv();
        const path = env.get("PATH");
        expect(typeof path).toBe("string");
        expect((path ?? "").length).toBeGreaterThan(0);
    });

    test("returns undefined for a variable that does not exist", () => {
        const env = new BunEnv();
        const val = env.get("__ADDA_NO_SUCH_VAR_12345__");
        expect(val).toBeUndefined();
    });
});
