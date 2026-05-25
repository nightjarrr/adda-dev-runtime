import { describe, expect, mock, test } from "bun:test";
import type { Shell, ShellDep, ShellResult, StdioDep } from "./lib/index";
import { VersionScript } from "./version";

type VersionDeps = ShellDep & StdioDep;

function makeMockDeps(
    runOverride?: (command: string[]) => Promise<ShellResult>,
): {
    deps: VersionDeps;
    outLines: string[];
    errLines: string[];
} {
    const outLines: string[] = [];
    const errLines: string[] = [];

    const defaultRun = async (command: string[]): Promise<ShellResult> => {
        if (command[0] === "bun")
            return { stdout: "1.3.14\n", stderr: "", exitCode: 0 };
        if (command[0] === "git")
            return { stdout: "git version 2.43.0\n", stderr: "", exitCode: 0 };
        if (command[0] === "gh")
            return {
                stdout: "gh version 2.65.0 (2025-01-01)\n",
                stderr: "",
                exitCode: 0,
            };
        return { stdout: "", stderr: "", exitCode: 127 };
    };

    const mockShell: Shell = {
        run: mock(runOverride ?? defaultRun),
    };

    const deps: VersionDeps = {
        shell: mockShell,
        stdio: {
            stdin: { text: mock(async () => "") },
            stdout: {
                write: mock((text: string) => {
                    outLines.push(text);
                }),
            },
            stderr: {
                write: mock((text: string) => {
                    errLines.push(text);
                }),
            },
        },
    };

    return { deps, outLines, errLines };
}

describe("VersionScript", () => {
    test("create() returns a VersionScript instance", () => {
        const script = VersionScript.create();
        expect(script).toBeInstanceOf(VersionScript);
    });

    test("returns exit code 0 on success", async () => {
        const { deps } = makeMockDeps();
        const script = new VersionScript(deps);
        const code = await script.run(["bun", "version.ts"]);
        expect(code).toBe(0);
    });

    test("writes bun version to stdout", async () => {
        const { deps, outLines } = makeMockDeps();
        const script = new VersionScript(deps);
        await script.run(["bun", "version.ts"]);
        expect(outLines.join("")).toContain("bun 1.3.14");
    });

    test("writes git version to stdout", async () => {
        const { deps, outLines } = makeMockDeps();
        const script = new VersionScript(deps);
        await script.run(["bun", "version.ts"]);
        expect(outLines.join("")).toContain("git version 2.43.0");
    });

    test("writes gh version to stdout", async () => {
        const { deps, outLines } = makeMockDeps();
        const script = new VersionScript(deps);
        await script.run(["bun", "version.ts"]);
        expect(outLines.join("")).toContain("gh version 2.65.0");
    });

    test("returns exit code 1 when bun --version fails", async () => {
        const { deps } = makeMockDeps(async (command) => {
            if (command[0] === "bun")
                return { stdout: "", stderr: "", exitCode: 1 };
            return { stdout: "ok\n", stderr: "", exitCode: 0 };
        });
        const script = new VersionScript(deps);
        const code = await script.run(["bun", "version.ts"]);
        expect(code).toBe(1);
    });

    test("returns exit code 1 when git --version fails", async () => {
        const { deps } = makeMockDeps(async (command) => {
            if (command[0] === "git")
                return { stdout: "", stderr: "", exitCode: 1 };
            return { stdout: "1.0\n", stderr: "", exitCode: 0 };
        });
        const script = new VersionScript(deps);
        const code = await script.run(["bun", "version.ts"]);
        expect(code).toBe(1);
    });

    test("returns exit code 1 when gh --version fails", async () => {
        const { deps } = makeMockDeps(async (command) => {
            if (command[0] === "gh")
                return { stdout: "", stderr: "", exitCode: 1 };
            return { stdout: "1.0\n", stderr: "", exitCode: 0 };
        });
        const script = new VersionScript(deps);
        const code = await script.run(["bun", "version.ts"]);
        expect(code).toBe(1);
    });
});
