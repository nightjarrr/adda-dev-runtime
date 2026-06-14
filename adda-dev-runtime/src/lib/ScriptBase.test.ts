import { describe, expect, mock, test } from "bun:test";
import type { parseArgs } from "node:util";
import type { StdioDep } from "./capabilities";
import { ScriptArgsError, ScriptError } from "./errors";
import { ScriptBase } from "./ScriptBase";

// --- Test helpers ---

function makeMockDeps(): {
    deps: StdioDep;
    outLines: string[];
    errLines: string[];
} {
    const outLines: string[] = [];
    const errLines: string[] = [];
    const deps: StdioDep = {
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

type ParsedArgs = ReturnType<typeof parseArgs>;

class NoArgScript extends ScriptBase<StdioDep, ParsedArgs> {
    private readonly executeFn: (args: ParsedArgs) => Promise<void>;

    constructor(deps: StdioDep, executeFn: (args: ParsedArgs) => Promise<void>) {
        super(deps);
        this.executeFn = executeFn;
    }

    protected argDefinitions(): Parameters<typeof parseArgs>[0] {
        return { options: {} };
    }

    protected validateArgs(parsed: ParsedArgs): ParsedArgs {
        return parsed;
    }

    protected async execute(args: ParsedArgs): Promise<void> {
        return this.executeFn(args);
    }
}

class FlagScript extends ScriptBase<StdioDep, ParsedArgs> {
    private readonly executeFn: (args: ParsedArgs) => Promise<void>;

    constructor(deps: StdioDep, executeFn: (args: ParsedArgs) => Promise<void>) {
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

    protected validateArgs(parsed: ParsedArgs): ParsedArgs {
        return parsed;
    }

    protected async execute(args: ParsedArgs): Promise<void> {
        return this.executeFn(args);
    }
}

class ValidateArgsErrorScript extends ScriptBase<StdioDep, ParsedArgs> {
    protected argDefinitions(): Parameters<typeof parseArgs>[0] {
        return { options: {} };
    }

    protected validateArgs(_parsed: ParsedArgs): ParsedArgs {
        throw new ScriptArgsError("missing required argument");
    }

    protected async execute(_args: ParsedArgs): Promise<void> {}
}

// --- Tests ---

describe("ScriptBase", () => {
    describe("successful run", () => {
        test("returns exit code 0", async () => {
            const { deps } = makeMockDeps();
            const script = new NoArgScript(deps, async () => {});
            const code = await script.run(["bun", "script.ts"]);
            expect(code).toBe(0);
        });

        test("slices argv past interpreter and script entries", async () => {
            const { deps } = makeMockDeps();
            let capturedArgs: ParsedArgs | undefined;
            const script = new FlagScript(deps, async (args) => {
                capturedArgs = args;
            });
            const code = await script.run(["bun", "script.ts", "--flag"]);
            expect(code).toBe(0);
            expect(capturedArgs?.values.flag).toBe(true);
        });
    });

    describe("ScriptError thrown in execute", () => {
        test("returns the error's exit code", async () => {
            const { deps } = makeMockDeps();
            const script = new NoArgScript(deps, async () => {
                throw new ScriptError("internal_error", "something failed", { exitCode: 3 });
            });
            const code = await script.run(["bun", "script.ts"]);
            expect(code).toBe(3);
        });

        test("writes error message to stderr", async () => {
            const { deps, errLines } = makeMockDeps();
            const script = new NoArgScript(deps, async () => {
                throw new ScriptError("internal_error", "domain error", { exitCode: 5 });
            });
            await script.run(["bun", "script.ts"]);
            expect(errLines.join("")).toContain("domain error");
        });

        test("emits envelope JSON to stdout", async () => {
            const { deps, outLines } = makeMockDeps();
            const script = new NoArgScript(deps, async () => {
                throw new ScriptError("internal_error", "oops");
            });
            await script.run(["bun", "script.ts"]);
            expect(outLines.join("")).toContain('"status":"fail"');
            expect(outLines.join("")).toContain('"reason":"internal_error"');
        });

        test("verboseStderr is written to stderr before error message", async () => {
            const { deps, errLines } = makeMockDeps();
            const script = new NoArgScript(deps, async () => {
                throw new ScriptError("internal_error", "short message", { verboseStderr: "verbose details from tool" });
            });
            await script.run(["bun", "script.ts"]);
            const combined = errLines.join("");
            expect(combined).toContain("verbose details from tool");
            expect(combined).toContain("Error: short message");
            // verboseStderr appears before the error message
            expect(combined.indexOf("verbose details from tool")).toBeLessThan(combined.indexOf("Error: short message"));
        });

        test("emits envelope with correct exit code for custom exitCode", async () => {
            const { deps, outLines } = makeMockDeps();
            const script = new NoArgScript(deps, async () => {
                throw new ScriptError("internal_error", "msg", { exitCode: 3 });
            });
            const code = await script.run(["bun", "script.ts"]);
            expect(code).toBe(3);
            expect(outLines.join("")).toContain('"status":"fail"');
        });
    });

    describe("uncaught exception in execute", () => {
        test("returns exit code 1", async () => {
            const { deps } = makeMockDeps();
            const script = new NoArgScript(deps, async () => {
                throw new Error("unexpected");
            });
            const code = await script.run(["bun", "script.ts"]);
            expect(code).toBe(1);
        });

        test("writes error message to stderr", async () => {
            const { deps, errLines } = makeMockDeps();
            const script = new NoArgScript(deps, async () => {
                throw new Error("runtime boom");
            });
            await script.run(["bun", "script.ts"]);
            expect(errLines.join("")).toContain("runtime boom");
        });

        test("handles non-Error thrown value", async () => {
            const { deps, errLines } = makeMockDeps();
            const script = new NoArgScript(deps, async () => {
                throw "string error";
            });
            const code = await script.run(["bun", "script.ts"]);
            expect(code).toBe(1);
            expect(errLines.join("")).toContain("string error");
        });

        test("does not emit envelope to stdout for non-ScriptError throws", async () => {
            const { deps, outLines } = makeMockDeps();
            const script = new NoArgScript(deps, async () => {
                throw new Error("unexpected");
            });
            await script.run(["bun", "script.ts"]);
            expect(outLines).toHaveLength(0);
        });
    });

    describe("argument parse failure", () => {
        test("returns exit code 2 for unknown flag", async () => {
            const { deps } = makeMockDeps();
            const script = new FlagScript(deps, async () => {});
            // --unknown is not in FlagScript's options with strict: true
            const code = await script.run(["bun", "script.ts", "--unknown"]);
            expect(code).toBe(2);
        });

        test("writes error message to stderr on parse failure", async () => {
            const { deps, errLines } = makeMockDeps();
            const script = new FlagScript(deps, async () => {});
            await script.run(["bun", "script.ts", "--unknown"]);
            expect(errLines.join("")).toContain("Error:");
        });

        test("emits invalid_args envelope to stdout on parse failure", async () => {
            const { deps, outLines } = makeMockDeps();
            const script = new FlagScript(deps, async () => {});
            await script.run(["bun", "script.ts", "--unknown"]);
            const out = JSON.parse(outLines.join("").trim()) as Record<string, unknown>;
            expect(out.status).toBe("fail");
            const error = out.error as Record<string, unknown>;
            expect(error.reason).toBe("invalid_args");
        });
    });

    describe("ScriptArgsError thrown in validateArgs", () => {
        test("returns exit code 2", async () => {
            const { deps } = makeMockDeps();
            const script = new ValidateArgsErrorScript(deps);
            const code = await script.run(["bun", "script.ts"]);
            expect(code).toBe(2);
        });

        test("emits invalid_args envelope to stdout", async () => {
            const { deps, outLines } = makeMockDeps();
            const script = new ValidateArgsErrorScript(deps);
            await script.run(["bun", "script.ts"]);
            const out = JSON.parse(outLines.join("").trim()) as Record<string, unknown>;
            expect(out.status).toBe("fail");
            const error = out.error as Record<string, unknown>;
            expect(error.reason).toBe("invalid_args");
        });
    });

    describe("emitOk", () => {
        test("writes status:ok envelope JSON with result to stdout", async () => {
            class EmitOkScript extends ScriptBase<StdioDep, ParsedArgs> {
                protected argDefinitions(): Parameters<typeof parseArgs>[0] {
                    return { options: {} };
                }

                protected validateArgs(parsed: ParsedArgs): ParsedArgs {
                    return parsed;
                }

                protected async execute(_args: ParsedArgs): Promise<void> {
                    this.emitOk<{ id: string; count: number }>({ id: "abc", count: 42 });
                }
            }

            const { deps, outLines } = makeMockDeps();
            const script = new EmitOkScript(deps);
            const code = await script.run(["bun", "script.ts"]);
            expect(code).toBe(0);
            const out = JSON.parse(outLines.join("").trim());
            expect(out.status).toBe("ok");
            expect(out.result).toEqual({ id: "abc", count: 42 });
            expect(out.error).toBeNull();
        });
    });
});
