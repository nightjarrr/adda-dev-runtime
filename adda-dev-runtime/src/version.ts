import type { parseArgs } from "node:util";
import type { EmptyArgs, ShellDep, StdioDep } from "@adda/lib";
import { defaultDeps, ScriptBase, ScriptError } from "@adda/lib";

type VersionDeps = ShellDep & StdioDep;

export class VersionScript extends ScriptBase<VersionDeps, EmptyArgs> {
    protected argDefinitions(): Parameters<typeof parseArgs>[0] {
        return { options: {} };
    }

    protected validateArgs(_parsed: ReturnType<typeof parseArgs>): EmptyArgs {
        return {};
    }

    protected async execute(_args: EmptyArgs): Promise<void> {
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

if (import.meta.main) process.exit(await new VersionScript(defaultDeps).run(process.argv));
