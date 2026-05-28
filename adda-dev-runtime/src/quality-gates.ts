import type { parseArgs } from "node:util";
import type { FileReaderDep, FileWriterDep, ShellDep, StdioDep, TmpDep } from "@adda/lib";
import { ConfigError, defaultDeps, ScriptBase, ScriptError } from "@adda/lib";

type QualityGatesDeps = ShellDep & FileReaderDep & FileWriterDep & TmpDep & StdioDep;

interface CheckResult {
    command: string;
    status: "PASS" | "FAIL";
    output: string;
}

interface QualityGatesResult {
    overall: "PASS" | "FAIL";
    checks: CheckResult[];
}

export class QualityGatesScript extends ScriptBase<QualityGatesDeps> {
    protected argDefinitions(): Parameters<typeof parseArgs>[0] {
        return { options: {}, strict: true };
    }

    protected async execute(): Promise<void> {
        const gitResult = await this.deps.shell.run(["git", "rev-parse", "--show-toplevel"]);
        const repoRoot = gitResult.stdout.trim();
        const confPath = `${repoRoot}/.quality-gates.conf`;

        let confContent: string;
        try {
            confContent = await this.deps.fileReader.readFile(confPath);
        } catch {
            throw new ConfigError(`${confPath} not found`);
        }

        const commands = confContent
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line.length > 0 && !line.startsWith("#"));

        if (commands.length === 0) {
            throw new ConfigError(`no checks defined in ${confPath}`);
        }

        const total = commands.length;
        let overall: "PASS" | "FAIL" = "PASS";
        const checks: CheckResult[] = [];

        for (let i = 0; i < commands.length; i++) {
            const cmd = commands[i];
            this.deps.stdio.stdout.write(`[${i + 1}/${total}] ${cmd}\n`);

            const result = await this.deps.shell.runSh(`${cmd} 2>&1`, { strict: false });
            const status: "PASS" | "FAIL" = result.exitCode === 0 ? "PASS" : "FAIL";

            if (status === "FAIL") overall = "FAIL";

            this.deps.stdio.stdout.write(`${status}\n`);
            checks.push({ command: cmd, status, output: result.stdout });
        }

        const resultPath = this.deps.tmp.tempFilePath("quality-gates", ".json");
        const resultData: QualityGatesResult = { overall, checks };
        await this.deps.fileWriter.writeFile(resultPath, JSON.stringify(resultData, null, 2));

        this.deps.stdio.stdout.write("===\n");
        this.deps.stdio.stdout.write(`${overall}\n`);
        this.deps.stdio.stdout.write(`Results: ${resultPath}\n`);

        if (overall === "FAIL") {
            throw new ScriptError("Quality gates failed", 1);
        }
    }
}

if (import.meta.main) process.exit(await new QualityGatesScript(defaultDeps).run(process.argv));
