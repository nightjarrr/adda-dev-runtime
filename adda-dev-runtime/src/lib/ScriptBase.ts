import { parseArgs } from "node:util";
import type { StdioDep } from "./capabilities";
import { ScriptArgsError, ScriptError } from "./errors";

export type EmptyArgs = Record<string, never>;

export abstract class ScriptBase<TDeps extends StdioDep, TArgs> {
    protected readonly deps: TDeps;

    constructor(deps: TDeps) {
        this.deps = deps;
    }

    protected abstract argDefinitions(): Parameters<typeof parseArgs>[0];

    protected abstract validateArgs(parsed: ReturnType<typeof parseArgs>): TArgs;

    protected abstract execute(args: TArgs): Promise<void>;

    protected emitOk<T>(result: T): void {
        this.emit({ status: "ok", result, error: null });
    }

    private emit<T = unknown>(value: T): void {
        this.deps.stdio.stdout.write(`${JSON.stringify(value)}\n`);
    }

    async run(argv: string[]): Promise<number> {
        const sliced = argv.slice(2);

        let parsed: ReturnType<typeof parseArgs>;
        try {
            parsed = parseArgs({ ...this.argDefinitions(), args: sliced });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            const scriptErr = new ScriptArgsError(message);
            this.emit(scriptErr.envelope);
            this.deps.stdio.stderr.write(`Error: ${scriptErr.message}\n`);
            return 2;
        }

        try {
            const args = this.validateArgs(parsed);
            await this.execute(args);
            return 0;
        } catch (err) {
            if (err instanceof ScriptError) {
                this.emit(err.envelope);
                if (err.verboseStderr) this.deps.stdio.stderr.write(err.verboseStderr);
                this.deps.stdio.stderr.write(`Error: ${err.message}\n`);
                return err.exitCode;
            }
            const message = err instanceof Error ? err.message : String(err);
            const internalErr = new ScriptError("internal_error", `Unexpected error: ${message}`);
            this.emit(internalErr.envelope);
            this.deps.stdio.stderr.write(`Unexpected error: ${message}\n`);
            return 1;
        }
    }
}
