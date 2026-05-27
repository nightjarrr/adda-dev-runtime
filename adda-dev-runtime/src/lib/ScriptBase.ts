import { parseArgs } from "node:util";
import type { StdioDep } from "./capabilities";
import { ScriptError } from "./errors";

export abstract class ScriptBase<TDeps extends StdioDep> {
    protected readonly deps: TDeps;

    constructor(deps: TDeps) {
        this.deps = deps;
    }

    protected abstract argDefinitions(): Parameters<typeof parseArgs>[0];

    protected abstract execute(args: ReturnType<typeof parseArgs>): Promise<void>;

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
            await this.execute(parsed);
            return 0;
        } catch (err) {
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
