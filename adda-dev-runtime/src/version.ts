import type { parseArgs } from "node:util";
import type { ShellDep, StdioDep } from "@adda/lib";
import { BunShell, BunStdio, ScriptBase, ScriptError } from "@adda/lib";

type VersionDeps = ShellDep & StdioDep;

export class VersionScript extends ScriptBase<VersionDeps> {
    static create(): VersionScript {
        return new VersionScript({
            shell: new BunShell(),
            stdio: new BunStdio(),
        });
    }

    protected argDefinitions(): Parameters<typeof parseArgs>[0] {
        return { options: {} };
    }

    protected async execute(): Promise<void> {
        const [bunResult, gitResult, ghResult] = await Promise.all([
            this.deps.shell.run(["bun", "--version"]),
            this.deps.shell.run(["git", "--version"]),
            this.deps.shell.run(["gh", "--version"]),
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

        this.deps.stdio.stdout.write(`bun ${bunResult.stdout.trim()}\n`);
        this.deps.stdio.stdout.write(`${gitResult.stdout.trim()}\n`);
        this.deps.stdio.stdout.write(`${ghResult.stdout.trim()}\n`);
    }
}

if (import.meta.main) process.exit(await VersionScript.create().run(process.argv));
