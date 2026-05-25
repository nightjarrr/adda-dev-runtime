import type { parseArgs } from "node:util";
import type { Shell, Stdio } from "./lib/index";
import { BunShell, BunStdio, ScriptBase, ScriptError } from "./lib/index";

type VersionDeps = Shell & Stdio;

export class VersionScript extends ScriptBase<VersionDeps> {
    static create(): VersionScript {
        const shell = new BunShell();
        const stdio = new BunStdio();
        const deps: VersionDeps = {
            run: shell.run.bind(shell),
            readLine: stdio.readLine.bind(stdio),
            writeOut: stdio.writeOut.bind(stdio),
            writeErr: stdio.writeErr.bind(stdio),
        };
        return new VersionScript(deps);
    }

    protected argDefinitions(): Parameters<typeof parseArgs>[0] {
        return { options: {} };
    }

    protected async execute(): Promise<void> {
        const [bunResult, gitResult, ghResult] = await Promise.all([
            this.deps.run(["bun", "--version"]),
            this.deps.run(["git", "--version"]),
            this.deps.run(["gh", "--version"]),
        ]);

        if (bunResult.exitCode !== 0) {
            throw new ScriptError("bun --version failed", 1);
        }
        if (gitResult.exitCode !== 0) {
            throw new ScriptError("git --version failed", 1);
        }
        if (ghResult.exitCode !== 0) {
            throw new ScriptError("gh --version failed", 1);
        }

        await this.deps.writeOut(`bun ${bunResult.stdout.trim()}\n`);
        await this.deps.writeOut(`${gitResult.stdout.trim()}\n`);
        await this.deps.writeOut(`${ghResult.stdout.trim()}\n`);
    }
}

if (import.meta.main)
    process.exit(await VersionScript.create().run(process.argv));
