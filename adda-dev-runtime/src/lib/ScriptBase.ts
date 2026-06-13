import { parseArgs } from "node:util";
import type { ShellResult, StdioDep } from "./capabilities";
import { ScriptError, ScriptStructuredError } from "./errors";

export type EmptyArgs = Record<string, never>;

export abstract class ScriptBase<TDeps extends StdioDep, TArgs> {
    protected readonly deps: TDeps;

    constructor(deps: TDeps) {
        this.deps = deps;
    }

    protected abstract argDefinitions(): Parameters<typeof parseArgs>[0];

    protected abstract validateArgs(parsed: ReturnType<typeof parseArgs>): TArgs;

    protected abstract execute(args: TArgs): Promise<void>;

    protected emit(value: unknown): void {
        this.deps.stdio.stdout.write(`${JSON.stringify(value)}\n`);
    }

    protected forwardStderr(result: ShellResult): void {
        if (result.stderr) {
            this.deps.stdio.stderr.write(result.stderr);
        }
    }

    async run(argv: string[]): Promise<number> {
        const sliced = argv.slice(2);

        let parsed: ReturnType<typeof parseArgs>;
        try {
            parsed = parseArgs({ ...this.argDefinitions(), args: sliced });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.deps.stdio.stderr.write(`Error: ${message}\n`);
            return 2;
        }

        try {
            const args = this.validateArgs(parsed);
            await this.execute(args);
            return 0;
        } catch (err) {
            if (err instanceof ScriptStructuredError) {
                this.deps.stdio.stdout.write(`${JSON.stringify(err.envelope)}\n`);
                this.deps.stdio.stderr.write(`Error: ${err.message}\n`);
                return err.exitCode;
            }
            if (err instanceof ScriptError) {
                this.deps.stdio.stderr.write(`Error: ${err.message}\n`);
                return err.exitCode;
            }
            const message = err instanceof Error ? err.message : String(err);
            this.deps.stdio.stderr.write(`Unexpected error: ${message}\n`);
            return 1;
        }
    }
}
