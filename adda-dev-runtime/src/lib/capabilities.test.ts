import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    BunEnv,
    BunFileReader,
    BunFileWriter,
    BunShell,
    BunStdio,
} from "./capabilities";

// --- BunShell ---

describe("BunShell", () => {
    test("runs a subprocess and returns stdout, stderr, and exit code 0", async () => {
        const shell = new BunShell();
        const result = await shell.run(["echo", "hello shell"]);
        expect(result.stdout.trim()).toBe("hello shell");
        expect(result.stderr).toBe("");
        expect(result.exitCode).toBe(0);
    });

    test("returns non-zero exit code for failing command", async () => {
        const shell = new BunShell();
        const result = await shell.run(["false"]);
        expect(result.exitCode).not.toBe(0);
    });

    test("captures stderr output", async () => {
        const shell = new BunShell();
        const result = await shell.run(["sh", "-c", "echo error-text >&2"]);
        expect(result.stderr.trim()).toBe("error-text");
        expect(result.exitCode).toBe(0);
    });
});

// --- BunFileReader ---

describe("BunFileReader", () => {
    let tmpDir: string;

    afterEach(async () => {
        if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
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
    test("stdin property is Bun.stdin", () => {
        const stdio = new BunStdio();
        expect(stdio.stdin).toBe(Bun.stdin);
    });

    test("stdout property is process.stdout", () => {
        const stdio = new BunStdio();
        expect(stdio.stdout).toBe(process.stdout);
    });

    test("stderr property is process.stderr", () => {
        const stdio = new BunStdio();
        expect(stdio.stderr).toBe(process.stderr);
    });
});

// --- BunEnv ---

describe("BunEnv", () => {
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
