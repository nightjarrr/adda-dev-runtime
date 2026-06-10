import type { parseArgs } from "node:util";
import type { EnvDep, FileReaderDep, FileSysDep, FileWriterDep, ShellDep, ShellResult, StdioDep } from "@adda/lib";
import { defaultDeps, parseJson, ScriptArgsError, ScriptBase, ScriptError } from "@adda/lib";

import { executeBranchEnsure, executeBranchVerify } from "./current-issue/branch";
import { executeClear } from "./current-issue/clear";
import { executeShow } from "./current-issue/show";
import { executeSwitch } from "./current-issue/switch";
import { executeSync } from "./current-issue/sync";
import type { Envelope, IssueState, IssueStateStore, ScriptOutput } from "./current-issue/types";
import { IssueStateSchema } from "./current-issue/types";

const STATE_PATH = "/run/adda/.adda-current-issue";
const STATE_TMP_PATH = "/run/adda/.adda-current-issue.tmp";

export type { IssueStateStore, ScriptOutput } from "./current-issue/types";

// --- Types ---

type CurrentIssueDeps = ShellDep & EnvDep & StdioDep & FileWriterDep & FileReaderDep & FileSysDep;

type CurrentIssueArgs =
    | { subcommand: "switch"; issueId: string; skipRepoInit: boolean }
    | { subcommand: "show" }
    | { subcommand: "sync"; skipRepoInit: boolean }
    | { subcommand: "clear"; skipRepoInit: boolean }
    | { subcommand: "get"; field: string }
    | { subcommand: "branch"; mode: "ensure" | "verify" }
    | { subcommand: "unknown"; name: string };

// --- Local helpers for get ---

export class SilentStore implements IssueStateStore {
    constructor(private deps: FileReaderDep) {}

    async readState(): Promise<IssueState | null> {
        try {
            const content = await this.deps.fileReader.readFile(STATE_PATH);
            if (!content.trim()) return null;
            let raw: unknown;
            try {
                raw = parseJson(content);
            } catch {
                return null;
            }
            const parsed = IssueStateSchema.safeParse(raw);
            return parsed.success ? parsed.data : null;
        } catch {
            return null;
        }
    }

    async writeState(_: IssueState): Promise<void> {
        throw new Error("not supported");
    }
    async deleteState(): Promise<void> {
        throw new Error("not supported");
    }
    async stateExists(): Promise<boolean> {
        throw new Error("not supported");
    }
}

class GetScriptOutput implements ScriptOutput {
    constructor(
        private field: string,
        private stdout: { write(text: string): void },
    ) {}

    emit(envelope: Envelope): void {
        if (envelope.status === "success" && envelope.issue) {
            const value = (envelope.issue as unknown as Record<string, string>)[this.field] ?? "";
            if (value) this.stdout.write(value + "\n");
        }
    }

    fail(_message: string): never {
        throw new Error("unreachable");
    }
    forwardStderr(_result: ShellResult): void {}
}

// --- Script ---

export class CurrentIssueScript
    extends ScriptBase<CurrentIssueDeps, CurrentIssueArgs>
    implements IssueStateStore, ScriptOutput
{
    protected argDefinitions(): Parameters<typeof parseArgs>[0] {
        return {
            allowPositionals: true,
            options: {
                "skip-repo-init": { type: "boolean", default: false },
                ensure: { type: "boolean", default: false },
                verify: { type: "boolean", default: false },
            },
        };
    }

    protected validateArgs(parsed: ReturnType<typeof parseArgs>): CurrentIssueArgs {
        const positionals = parsed.positionals;
        const subcommand = positionals[0];

        if (!subcommand) {
            this.emit({ status: "error", issue: null, details: {}, error: "usage: current-issue <subcommand> [args]" });
            throw new ScriptArgsError("usage: current-issue <subcommand> [args]");
        }

        const skipRepoInit = (parsed.values["skip-repo-init"] as boolean | undefined) ?? false;
        if (skipRepoInit && (subcommand === "show" || subcommand === "get")) {
            const error = `--skip-repo-init is not valid for '${subcommand}'`;
            this.emit({ status: "error", issue: null, details: {}, error });
            throw new ScriptArgsError(error);
        }

        const ensure = (parsed.values["ensure"] as boolean | undefined) ?? false;
        const verify = (parsed.values["verify"] as boolean | undefined) ?? false;
        if ((ensure || verify) && subcommand !== "branch") {
            const flag = ensure ? "--ensure" : "--verify";
            const error = `${flag} is not valid for '${subcommand}'`;
            this.emit({ status: "error", issue: null, details: {}, error });
            throw new ScriptArgsError(error);
        }

        if (subcommand === "switch") {
            const issueId = positionals[1];
            if (!issueId) {
                this.emit({ status: "error", issue: null, details: {}, error: "usage: current-issue switch <id>" });
                throw new ScriptArgsError("usage: current-issue switch <id>");
            }
            return { subcommand: "switch", issueId, skipRepoInit };
        }

        if (subcommand === "show") {
            if (positionals.length > 1) {
                this.emit({ status: "error", issue: null, details: {}, error: "usage: current-issue show" });
                throw new ScriptArgsError("usage: current-issue show");
            }
            return { subcommand: "show" };
        }

        if (subcommand === "sync") {
            return { subcommand: "sync", skipRepoInit };
        }

        if (subcommand === "clear") {
            return { subcommand: "clear", skipRepoInit };
        }

        if (subcommand === "get") {
            const field = positionals[1];
            if (!field) {
                this.emit({ status: "error", issue: null, details: {}, error: "usage: current-issue get <field>" });
                throw new ScriptArgsError("usage: current-issue get <field>");
            }
            return { subcommand: "get", field };
        }

        if (subcommand === "branch") {
            if (skipRepoInit) {
                const error = "--skip-repo-init is not valid for 'branch'";
                this.emit({ status: "error", issue: null, details: {}, error });
                throw new ScriptArgsError(error);
            }
            if (ensure && verify) {
                const error = "--ensure and --verify are mutually exclusive";
                this.emit({ status: "error", issue: null, details: {}, error });
                throw new ScriptArgsError(error);
            }
            if (!ensure && !verify) {
                const error = "usage: current-issue branch --ensure | --verify";
                this.emit({ status: "error", issue: null, details: {}, error });
                throw new ScriptArgsError(error);
            }
            return { subcommand: "branch", mode: ensure ? "ensure" : "verify" };
        }

        return { subcommand: "unknown", name: subcommand };
    }

    protected async execute(args: CurrentIssueArgs): Promise<void> {
        switch (args.subcommand) {
            case "switch":
                await executeSwitch(args.issueId, args.skipRepoInit, this.deps, this, this);
                return;
            case "show":
                await executeShow(this, this);
                return;
            case "sync":
                await executeSync(args.skipRepoInit, this.deps, this, this);
                return;
            case "clear":
                await executeClear(args.skipRepoInit, this.deps, this, this);
                return;
            case "get":
                try {
                    await executeShow(new SilentStore(this.deps), new GetScriptOutput(args.field, this.deps.stdio.stdout));
                } catch {}
                return;
            case "branch":
                if (args.mode === "ensure") await executeBranchEnsure(this.deps, this, this);
                else await executeBranchVerify(this.deps, this, this);
                return;
            default: {
                const message = `unknown subcommand: ${args.name}`;
                this.fail(message);
            }
        }
    }

    // --- ScriptOutput ---

    emit(envelope: Envelope): void {
        this.deps.stdio.stdout.write(`${JSON.stringify(envelope)}\n`);
    }

    forwardStderr(result: ShellResult): void {
        if (result.stderr) {
            this.deps.stdio.stderr.write(result.stderr);
        }
    }

    fail(message: string, details?: Record<string, unknown>): never {
        this.emit({ status: "error", issue: null, details: details ?? {}, error: message });
        throw new ScriptError(message);
    }

    // --- IssueStateStore ---

    async readState(): Promise<IssueState | null> {
        let content: string;
        try {
            content = await this.deps.fileReader.readFile(STATE_PATH);
        } catch (err) {
            if (err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT") {
                return null;
            }
            throw err;
        }

        if (!content.trim()) {
            return null;
        }

        let raw: unknown;
        try {
            raw = parseJson(content);
        } catch {
            this.fail("state file is corrupt — run 'current-issue clear' to reset");
        }

        const parsed = IssueStateSchema.safeParse(raw);
        if (!parsed.success) {
            this.fail("state file is corrupt — run 'current-issue clear' to reset");
        }

        return parsed.data;
    }

    async writeState(state: IssueState): Promise<void> {
        await this.deps.fileWriter.writeFile(STATE_TMP_PATH, JSON.stringify(state));
        await this.deps.fileSys.renameFile(STATE_TMP_PATH, STATE_PATH);
    }

    async deleteState(): Promise<void> {
        await this.deps.fileSys.deleteFile(STATE_PATH);
    }

    async stateExists(): Promise<boolean> {
        return this.deps.fileSys.fileExists(STATE_PATH);
    }
}

if (import.meta.main) process.exit(await new CurrentIssueScript(defaultDeps).run(process.argv));
