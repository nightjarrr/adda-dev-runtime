import type { parseArgs } from "node:util";
import type { EnvDep, FileReaderDep, FileSysDep, FileWriterDep, ShellDep, ShellResult, StdioDep } from "@adda/lib";
import { defaultDeps, parseJson, ScriptArgsError, ScriptBase, ScriptError, ScriptZodValidationError } from "@adda/lib";
import { z } from "zod";

// --- Constants ---

const STATE_PATH = "/run/.adda-current-issue";
const STATE_TMP_PATH = "/run/.adda-current-issue.tmp";

// --- Schemas ---

const IssueStateSchema = z.object({
    id: z.string(),
    title: z.string(),
    type: z.string(),
    phase: z.string(),
    state: z.string(),
    pr: z.string(),
});

const GhIssueSchema = z.object({
    title: z.string(),
    labels: z.array(z.object({ name: z.string() })),
    state: z.enum(["OPEN", "CLOSED"]),
});

const ResolveIssueBranchOutputSchema = z.object({
    status: z.string(),
    branch: z.string(),
    pr: z.string(),
    details: z.string(),
});

// --- Types ---

type IssueState = z.infer<typeof IssueStateSchema>;

type CurrentIssueDeps = ShellDep & EnvDep & StdioDep & FileWriterDep & FileReaderDep & FileSysDep;

type CurrentIssueArgs = { subcommand: "switch"; issueId: string } | { subcommand: "unknown"; name: string };

// --- Output envelope ---

interface SuccessEnvelope {
    status: "success";
    issue: IssueState;
    details: { branch: string; resolution: string };
    error: "";
}

interface ErrorEnvelope {
    status: "error";
    issue: null;
    details: Record<string, never>;
    error: string;
}

type Envelope = SuccessEnvelope | ErrorEnvelope;

// --- Script ---

export class CurrentIssueScript extends ScriptBase<CurrentIssueDeps, CurrentIssueArgs> {
    protected argDefinitions(): Parameters<typeof parseArgs>[0] {
        return { allowPositionals: true, options: {} };
    }

    protected validateArgs(parsed: ReturnType<typeof parseArgs>): CurrentIssueArgs {
        const positionals = parsed.positionals;
        const subcommand = positionals[0];

        if (!subcommand) {
            this.emit({ status: "error", issue: null, details: {}, error: "usage: current-issue <subcommand> [args]" });
            throw new ScriptArgsError("usage: current-issue <subcommand> [args]");
        }

        if (subcommand === "switch") {
            const issueId = positionals[1];
            if (!issueId) {
                this.emit({ status: "error", issue: null, details: {}, error: "usage: current-issue switch <id>" });
                throw new ScriptArgsError("usage: current-issue switch <id>");
            }
            return { subcommand: "switch", issueId };
        }

        return { subcommand: "unknown", name: subcommand };
    }

    protected async execute(args: CurrentIssueArgs): Promise<void> {
        if (args.subcommand === "switch") {
            await this.executeSwitch(args.issueId);
            return;
        }

        const message = `unknown subcommand: ${args.name}`;
        this.emit({ status: "error", issue: null, details: {}, error: message });
        throw new ScriptError(message);
    }

    // --- Private helpers ---

    private emit(envelope: Envelope): void {
        this.deps.stdio.stdout.write(`${JSON.stringify(envelope)}\n`);
    }

    private forwardStderr(result: ShellResult): void {
        if (result.stderr) {
            this.deps.stdio.stderr.write(result.stderr);
        }
    }

    private async readState(): Promise<IssueState | null> {
        let content: string;
        try {
            content = await this.deps.fileReader.readFile(STATE_PATH);
        } catch {
            return null;
        }

        if (!content.trim()) {
            return null;
        }

        let raw: unknown;
        try {
            raw = parseJson(content);
        } catch {
            throw new ScriptError("state file is corrupt — run 'current-issue clear' to reset");
        }

        const parsed = IssueStateSchema.safeParse(raw);
        if (!parsed.success) {
            throw new ScriptError("state file is corrupt — run 'current-issue clear' to reset");
        }

        return parsed.data;
    }

    private async writeState(state: IssueState): Promise<void> {
        await this.deps.fileWriter.writeFile(STATE_TMP_PATH, JSON.stringify(state));
        await this.deps.fileSys.renameFile(STATE_TMP_PATH, STATE_PATH);
    }

    private async deleteState(): Promise<void> {
        await this.deps.fileSys.deleteFile(STATE_PATH);
    }

    private async executeSwitch(issueId: string): Promise<void> {
        // Step 1: Validate env vars
        const owner = this.deps.env.get("GITHUB_OWNER");
        if (!owner) {
            const message = "required environment variable 'GITHUB_OWNER' is not set";
            this.emit({ status: "error", issue: null, details: {}, error: message });
            throw new ScriptError(message);
        }

        const repo = this.deps.env.get("GITHUB_REPO");
        if (!repo) {
            const message = "required environment variable 'GITHUB_REPO' is not set";
            this.emit({ status: "error", issue: null, details: {}, error: message });
            throw new ScriptError(message);
        }

        // Step 2: Check dirty tree
        const statusResult = await this.deps.shell.run(["git", "status", "--porcelain"], { strict: false });
        if (statusResult.stdout.trim()) {
            const message = "working tree is dirty — commit or stash changes before switching issues";
            this.emit({ status: "error", issue: null, details: {}, error: message });
            throw new ScriptError(message);
        }

        // Step 3: Fetch issue metadata
        const ghResult = await this.deps.shell.run(["gh", "issue", "view", issueId, "--json", "title,labels,state"], {
            strict: false,
        });
        if (ghResult.exitCode !== 0) {
            const message = `failed to fetch issue #${issueId}: ${ghResult.stderr.trim() || ghResult.stdout.trim()}`;
            this.emit({ status: "error", issue: null, details: {}, error: message });
            throw new ScriptError(message);
        }

        const ghRaw = parseJson(ghResult.stdout);
        const ghParsed = GhIssueSchema.safeParse(ghRaw);
        if (!ghParsed.success) {
            const err = new ScriptZodValidationError("unexpected gh issue response", ghParsed.error, ghRaw);
            this.emit({ status: "error", issue: null, details: {}, error: err.short });
            throw err;
        }

        const { title, labels, state } = ghParsed.data;

        const typeLabel = labels.find((l) => /^(feature|bug|chore|docs)$/.test(l.name))?.name ?? "";
        const phaseLabel = labels.find((l) => l.name.startsWith("phase:"))?.name ?? "";

        // Step 4: Resolve branch
        const resolveResult = await this.deps.shell.run(["resolve-issue-branch", issueId], { strict: false });
        if (resolveResult.exitCode !== 0) {
            this.forwardStderr(resolveResult);
            const message = `resolve-issue-branch failed for issue #${issueId}`;
            this.emit({ status: "error", issue: null, details: {}, error: message });
            throw new ScriptError(message);
        }

        const resolveRaw = parseJson(resolveResult.stdout);
        const resolveParsed = ResolveIssueBranchOutputSchema.safeParse(resolveRaw);
        if (!resolveParsed.success) {
            const err = new ScriptZodValidationError("unexpected resolve-issue-branch output", resolveParsed.error, resolveRaw);
            this.emit({ status: "error", issue: null, details: {}, error: err.short });
            throw err;
        }

        const resolveData = resolveParsed.data;

        if (resolveData.status === "ambiguous" || resolveData.status === "error") {
            this.forwardStderr(resolveResult);
            const message = `resolve-issue-branch returned '${resolveData.status}' for issue #${issueId}: ${resolveData.details}`;
            this.emit({ status: "error", issue: null, details: {}, error: message });
            throw new ScriptError(message);
        }

        // Step 5: Determine branch
        const branch = resolveData.status === "main" ? "main" : resolveData.branch;

        // Step 6: Checkout branch
        const checkoutResult = await this.deps.shell.run(["git", "checkout", branch], { strict: false });
        if (checkoutResult.exitCode !== 0) {
            const message = `git checkout '${branch}' failed: ${checkoutResult.stderr.trim() || checkoutResult.stdout.trim()}`;
            this.emit({ status: "error", issue: null, details: {}, error: message });
            throw new ScriptError(message);
        }

        // Step 7: Write state and emit success
        const issueState: IssueState = {
            id: issueId,
            title,
            type: typeLabel,
            phase: phaseLabel,
            state,
            pr: resolveData.pr,
        };

        await this.writeState(issueState);

        this.emit({
            status: "success",
            issue: issueState,
            details: { branch, resolution: resolveData.status },
            error: "",
        });
    }
}

if (import.meta.main) process.exit(await new CurrentIssueScript(defaultDeps).run(process.argv));
