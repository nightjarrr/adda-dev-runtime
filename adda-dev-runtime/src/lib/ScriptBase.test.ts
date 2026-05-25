import { describe, expect, mock, test } from "bun:test";
import type { parseArgs } from "node:util";
import type { Stdio } from "./capabilities";
import { ScriptBase, ScriptError } from "./ScriptBase";

// --- Test helpers ---

function makeMockStdio(): {
    stdio: Stdio;
    outLines: string[];
    errLines: string[];
} {
    const outLines: string[] = [];
    const errLines: string[] = [];
    const stdio: Stdio = {
        readLine: mock(async () => ""),
        writeOut: mock(async (text: string) => {
            outLines.push(text);
        }),
        writeErr: mock(async (text: string) => {
            errLines.push(text);
        }),
    };
    return { stdio, outLines, errLines };
}

type ParsedArgs = ReturnType<typeof parseArgs>;

class NoArgScript extends ScriptBase<Stdio> {
    private readonly executeFn: (args: ParsedArgs) => Promise<void>;

    constructor(deps: Stdio, executeFn: (args: ParsedArgs) => Promise<void>) {
        super(deps);
        this.executeFn = executeFn;
    }

    protected argDefinitions(): Parameters<typeof parseArgs>[0] {
        return { options: {} };
    }

    protected async execute(args: ParsedArgs): Promise<void> {
        return this.executeFn(args);
    }
}

class FlagScript extends ScriptBase<Stdio> {
    private readonly executeFn: (args: ParsedArgs) => Promise<void>;

    constructor(deps: Stdio, executeFn: (args: ParsedArgs) => Promise<void>) {
        super(deps);
        this.executeFn = executeFn;
    }

    protected argDefinitions(): Parameters<typeof parseArgs>[0] {
        return {
            options: {
                flag: { type: "boolean" },
            },
            strict: true,
        };
    }

    protected async execute(args: ParsedArgs): Promise<void> {
        return this.executeFn(args);
    }
}

// --- Tests ---

describe("ScriptBase", () => {
    describe("successful run", () => {
        test("returns exit code 0", async () => {
            const { stdio } = makeMockStdio();
            const script = new NoArgScript(stdio, async () => {});
            const code = await script.run(["bun", "script.ts"]);
            expect(code).toBe(0);
        });

        test("slices argv past interpreter and script entries", async () => {
            const { stdio } = makeMockStdio();
            let capturedArgs: ParsedArgs | undefined;
            const script = new FlagScript(stdio, async (args) => {
                capturedArgs = args;
            });
            const code = await script.run(["bun", "script.ts", "--flag"]);
            expect(code).toBe(0);
            expect(capturedArgs?.values.flag).toBe(true);
        });
    });

    describe("ScriptError thrown in execute", () => {
        test("returns the error's exit code", async () => {
            const { stdio } = makeMockStdio();
            const script = new NoArgScript(stdio, async () => {
                throw new ScriptError("something failed", 3);
            });
            const code = await script.run(["bun", "script.ts"]);
            expect(code).toBe(3);
        });

        test("writes error message to stderr", async () => {
            const { stdio, errLines } = makeMockStdio();
            const script = new NoArgScript(stdio, async () => {
                throw new ScriptError("domain error", 5);
            });
            await script.run(["bun", "script.ts"]);
            expect(errLines.join("")).toContain("domain error");
        });
    });

    describe("uncaught exception in execute", () => {
        test("returns exit code 1", async () => {
            const { stdio } = makeMockStdio();
            const script = new NoArgScript(stdio, async () => {
                throw new Error("unexpected");
            });
            const code = await script.run(["bun", "script.ts"]);
            expect(code).toBe(1);
        });

        test("writes error message to stderr", async () => {
            const { stdio, errLines } = makeMockStdio();
            const script = new NoArgScript(stdio, async () => {
                throw new Error("runtime boom");
            });
            await script.run(["bun", "script.ts"]);
            expect(errLines.join("")).toContain("runtime boom");
        });

        test("handles non-Error thrown value", async () => {
            const { stdio, errLines } = makeMockStdio();
            const script = new NoArgScript(stdio, async () => {
                throw "string error";
            });
            const code = await script.run(["bun", "script.ts"]);
            expect(code).toBe(1);
            expect(errLines.join("")).toContain("string error");
        });
    });

    describe("argument parse failure", () => {
        test("returns exit code 2 for unknown flag", async () => {
            const { stdio } = makeMockStdio();
            const script = new FlagScript(stdio, async () => {});
            // --unknown is not in FlagScript's options with strict: true
            const code = await script.run(["bun", "script.ts", "--unknown"]);
            expect(code).toBe(2);
        });

        test("writes error message to stderr on parse failure", async () => {
            const { stdio, errLines } = makeMockStdio();
            const script = new FlagScript(stdio, async () => {});
            await script.run(["bun", "script.ts", "--unknown"]);
            expect(errLines.join("")).toContain("Error:");
        });
    });

    describe("ScriptError", () => {
        test("stores exit code and message", () => {
            const err = new ScriptError("test message", 7);
            expect(err.message).toBe("test message");
            expect(err.exitCode).toBe(7);
            expect(err.name).toBe("ScriptError");
            expect(err).toBeInstanceOf(Error);
        });
    });
});
