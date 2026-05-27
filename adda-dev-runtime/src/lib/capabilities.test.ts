import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunEnv, BunFileReader, BunFileWriter, BunShell, BunStdio, BunTmp } from "./capabilities";

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

    describe("runSh", () => {
        test("invokes run with ['sh', '-c', cmd]", async () => {
            const shell = new BunShell();
            let capturedCommand: string[] | undefined;
            shell.run = async (command: string[]) => {
                capturedCommand = command;
                return { stdout: "mocked", stderr: "", exitCode: 0 };
            };

            await shell.runSh("echo hello");

            expect(capturedCommand).toEqual(["sh", "-c", "echo hello"]);
        });

        test("returns the result from run", async () => {
            const shell = new BunShell();
            const result = await shell.runSh("echo runSh-output");
            expect(result.stdout.trim()).toBe("runSh-output");
            expect(result.exitCode).toBe(0);
        });

        test("executes shell features (glob expansion)", async () => {
            const tmpDir = await mkdtemp(join(tmpdir(), "adda-runsh-"));
            try {
                await writeFile(join(tmpDir, "a.txt"), "");
                await writeFile(join(tmpDir, "b.txt"), "");
                const shell = new BunShell();
                const result = await shell.runSh(`echo ${tmpDir}/*.txt`);
                expect(result.exitCode).toBe(0);
                expect(result.stdout).toContain("a.txt");
                expect(result.stdout).toContain("b.txt");
            } finally {
                await rm(tmpDir, { recursive: true, force: true });
            }
        });
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

// --- BunTmp ---

describe("BunTmp", () => {
    const createdDirs: string[] = [];

    afterEach(async () => {
        for (const dir of createdDirs) {
            await rm(dir, { recursive: true, force: true });
        }
        createdDirs.length = 0;
    });

    describe("tempFilePath", () => {
        test("returns a string path under os.tmpdir()", () => {
            const tmp = new BunTmp();
            const path = tmp.tempFilePath();
            expect(path.startsWith(tmpdir())).toBe(true);
        });

        test("contains the given prefix", () => {
            const tmp = new BunTmp();
            const path = tmp.tempFilePath("myprefix");
            expect(path).toContain("myprefix");
        });

        test("ends with the given suffix", () => {
            const tmp = new BunTmp();
            const path = tmp.tempFilePath("pre", ".json");
            expect(path.endsWith(".json")).toBe(true);
        });

        test("uses default prefix 'tmp' when not provided", () => {
            const tmp = new BunTmp();
            const path = tmp.tempFilePath();
            const basename = path.slice(tmpdir().length + 1);
            expect(basename.startsWith("tmp-")).toBe(true);
        });

        test("returns a unique path each call", () => {
            const tmp = new BunTmp();
            const a = tmp.tempFilePath();
            const b = tmp.tempFilePath();
            expect(a).not.toBe(b);
        });
    });

    describe("makeTempDir", () => {
        test("creates a directory under os.tmpdir()", async () => {
            const tmp = new BunTmp();
            const dir = tmp.makeTempDir("adda-test");
            createdDirs.push(dir);
            expect(dir.startsWith(tmpdir())).toBe(true);
            const info = await stat(dir);
            expect(info.isDirectory()).toBe(true);
        });

        test("directory name contains the given prefix", () => {
            const tmp = new BunTmp();
            const dir = tmp.makeTempDir("mypfx");
            createdDirs.push(dir);
            expect(dir).toContain("mypfx");
        });

        test("uses default prefix 'tmp' when not provided", () => {
            const tmp = new BunTmp();
            const dir = tmp.makeTempDir();
            createdDirs.push(dir);
            const basename = dir.slice(tmpdir().length + 1);
            expect(basename.startsWith("tmp-")).toBe(true);
        });
    });
});
