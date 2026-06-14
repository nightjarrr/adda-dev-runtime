import type { parseArgs } from "node:util";
import { z } from "zod";
import type { EmptyArgs, FileReaderDep, FileWriterDep, ShellDep, StdioDep } from "@adda/lib";
import { ConfigError, defaultDeps, ScriptBase, ScriptError } from "@adda/lib";

type QualityGatesDeps = ShellDep & FileReaderDep & FileWriterDep & StdioDep;

const GateSchema = z.object({
    name: z.string().min(1),
    description: z.string(),
    command: z.string().min(1),
});

const ConfigSchema = z.object({
    gate: z.array(GateSchema).min(1),
});

interface GateResult {
    name: string;
    description: string;
    command: string;
    status: "PASS" | "FAIL";
    output: string;
}

interface QualityGatesResult {
    overall: "PASS" | "FAIL";
    gates: GateResult[];
    resultsFile: string;
}

export class QualityGatesScript extends ScriptBase<QualityGatesDeps, EmptyArgs> {
    protected argDefinitions(): Parameters<typeof parseArgs>[0] {
        return { options: {}, strict: true };
    }

    protected validateArgs(_parsed: ReturnType<typeof parseArgs>): EmptyArgs {
        return {};
    }

    protected async execute(_args: EmptyArgs): Promise<void> {
        const gitResult = await this.deps.shell.run(["git", "rev-parse", "--show-toplevel"]);
        const repoRoot = gitResult.stdout.trim();
        const confPath = `${repoRoot}/.quality-gates.toml`;

        let confContent: string;
        try {
            confContent = await this.deps.fileReader.readFile(confPath);
        } catch {
            throw new ConfigError(`${confPath} not found`);
        }

        let parsed: unknown;
        try {
            parsed = Bun.TOML.parse(confContent);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            throw new ConfigError(`failed to parse ${confPath}: ${msg}`);
        }

        const validated = ConfigSchema.safeParse(parsed);
        if (!validated.success) {
            const issues = validated.error.issues
                .map((i) => `${i.path.length > 0 ? i.path.join(".") : "(root)"}: ${i.message}`)
                .join("; ");
            throw new ConfigError(`invalid config in ${confPath}: ${issues}`);
        }

        const gates = validated.data.gate;
        let overall: "PASS" | "FAIL" = "PASS";
        const results: GateResult[] = [];

        for (const gate of gates) {
            const result = await this.deps.shell.runSh(`${gate.command} 2>&1`, { strict: false });
            const status: "PASS" | "FAIL" = result.exitCode === 0 ? "PASS" : "FAIL";

            if (status === "FAIL") overall = "FAIL";

            results.push({
                name: gate.name,
                description: gate.description,
                command: gate.command,
                status,
                output: result.stdout,
            });
        }

        const resultData = { overall, gates: results };
        const resultPath = await this.deps.fileWriter.writeFile(
            "<tmpDir>/quality-gates-<uuid>.json",
            JSON.stringify(resultData, null, 2),
        );

        if (overall === "FAIL") {
            throw new ScriptError<"gates_failed">("gates_failed", "Quality gates failed", {
                details: { resultsFile: resultPath },
                exitCode: 1,
            });
        }

        this.emitOk<QualityGatesResult>({ overall: "PASS", gates: results, resultsFile: resultPath });
    }
}

if (import.meta.main) process.exit(await new QualityGatesScript(defaultDeps).run(process.argv));
