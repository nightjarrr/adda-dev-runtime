import type { parseArgs } from "node:util";
import type { EnvDep, FileReaderDep, FileSysDep, FileWriterDep, ShellDep, StdioDep } from "@adda/lib";
import { defaultDeps, parseJson, ScriptBase } from "@adda/lib";

import { executeBranchEnsure, executeBranchVerify } from "./current-issue/branch";
import { executeClear } from "./current-issue/clear";
import { executeShow } from "./current-issue/show";
import { executeSwitch } from "./current-issue/switch";
import { executeSync } from "./current-issue/sync";
import { CurrentIssueError } from "./current-issue/types";
import type { IssueState, IssueStateStore } from "./current-issue/types";
import { IssueStateSchema } from "./current-issue/types";

const STATE_PATH = "/run/adda/.adda-current-issue";

export type { IssueStateStore } from "./current-issue/types";

// --- Types ---

type CurrentIssueDeps = ShellDep & EnvDep & StdioDep & FileReaderDep & FileWriterDep & FileSysDep;

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

// --- Script ---

export class CurrentIssueScript extends ScriptBase<CurrentIssueDeps, CurrentIssueArgs> implements IssueStateStore {
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
            throw new CurrentIssueError("invalid_args", "usage: current-issue <subcommand> [args]", { exitCode: 2 });
        }

        const skipRepoInit = (parsed.values["skip-repo-init"] as boolean | undefined) ?? false;
        if (skipRepoInit && (subcommand === "show" || subcommand === "get")) {
            throw new CurrentIssueError("invalid_args", `--skip-repo-init is not valid for '${subcommand}'`, {
                exitCode: 2,
            });
        }

        const ensure = (parsed.values["ensure"] as boolean | undefined) ?? false;
        const verify = (parsed.values["verify"] as boolean | undefined) ?? false;
        if ((ensure || verify) && subcommand !== "branch") {
            const flag = ensure ? "--ensure" : "--verify";
            throw new CurrentIssueError("invalid_args", `${flag} is not valid for '${subcommand}'`, { exitCode: 2 });
        }

        if (subcommand === "switch") {
            const issueId = positionals[1];
            if (!issueId) {
                throw new CurrentIssueError("invalid_args", "usage: current-issue switch <id>", { exitCode: 2 });
            }
            return { subcommand: "switch", issueId, skipRepoInit };
        }

        if (subcommand === "show") {
            if (positionals.length > 1) {
                throw new CurrentIssueError("invalid_args", "usage: current-issue show", { exitCode: 2 });
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
                throw new CurrentIssueError("invalid_args", "usage: current-issue get <field>", { exitCode: 2 });
            }
            return { subcommand: "get", field };
        }

        if (subcommand === "branch") {
            if (skipRepoInit) {
                throw new CurrentIssueError("invalid_args", "--skip-repo-init is not valid for 'branch'", {
                    exitCode: 2,
                });
            }
            if (ensure && verify) {
                throw new CurrentIssueError("invalid_args", "--ensure and --verify are mutually exclusive", {
                    exitCode: 2,
                });
            }
            if (!ensure && !verify) {
                throw new CurrentIssueError("invalid_args", "usage: current-issue branch --ensure | --verify", {
                    exitCode: 2,
                });
            }
            return { subcommand: "branch", mode: ensure ? "ensure" : "verify" };
        }

        return { subcommand: "unknown", name: subcommand };
    }

    protected async execute(args: CurrentIssueArgs): Promise<void> {
        switch (args.subcommand) {
            case "switch":
                this.emitOk(await executeSwitch(args.issueId, args.skipRepoInit, this.deps, this));
                return;
            case "show":
                this.emitOk(await executeShow(this));
                return;
            case "sync":
                this.emitOk(await executeSync(args.skipRepoInit, this.deps, this));
                return;
            case "clear":
                this.emitOk(await executeClear(args.skipRepoInit, this.deps, this));
                return;
            case "get": {
                const result = await executeShow(new SilentStore(this.deps)).catch(() => null);
                if (result?.issue) {
                    const value = (result.issue as unknown as Record<string, string>)[args.field] ?? "";
                    if (value) this.deps.stdio.stdout.write(value + "\n");
                }
                return;
            }
            case "branch":
                if (args.mode === "ensure") this.emitOk(await executeBranchEnsure(this.deps, this));
                else this.emitOk(await executeBranchVerify(this.deps, this));
                return;
            default: {
                throw new CurrentIssueError("invalid_args", `unknown subcommand: ${args.name}`, { exitCode: 2 });
            }
        }
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
            throw new CurrentIssueError("api_error", "state file is corrupt — run 'current-issue clear' to reset");
        }

        const parsed = IssueStateSchema.safeParse(raw);
        if (!parsed.success) {
            throw new CurrentIssueError("validation_error", "state file is corrupt — run 'current-issue clear' to reset");
        }

        return parsed.data;
    }

    async writeState(state: IssueState): Promise<void> {
        await this.deps.fileWriter.writeFile(STATE_PATH, JSON.stringify(state));
    }

    async deleteState(): Promise<void> {
        await this.deps.fileSys.deleteFile(STATE_PATH);
    }

    async stateExists(): Promise<boolean> {
        return this.deps.fileSys.fileExists(STATE_PATH);
    }
}

if (import.meta.main) process.exit(await new CurrentIssueScript(defaultDeps).run(process.argv));
