import type { parseArgs } from "node:util";
import type { EmptyArgs, EnvDep, FileReaderDep, ShellDep, StdioDep } from "@adda/lib";
import { defaultDeps, parseJson, ScriptBase, ScriptError } from "@adda/lib";
import { z } from "zod";

// --- Types ---

export type Tool = { name: string; cmd: string; desc: string };

type RenderAddaShellToolsDeps = FileReaderDep & ShellDep & StdioDep & EnvDep;

// --- Constants ---

const ToolSchema = z.object({ name: z.string(), cmd: z.string(), desc: z.string() });

/**
 * Scripting tools absent from the container — when bun is available, each has
 * a tailored "use bun instead" message; otherwise they fold into the absent list.
 */
export const SCRIPTING_PROBES: Record<string, string> = {
    python: "use `bun -e '<code>'` for inline scripts or `bun run <file.ts>`",
    python3: "use `bun -e '<code>'` for inline scripts or `bun run <file.ts>`",
    node: "use `bun run <file.ts>` or `bun -e '<code>'`",
    pip: "use `bun add <package>` to install dependencies",
    npm: "use `bun install` / `bun add <package>` for dependency management",
};

/**
 * Tools that are present in the container image but non-functional due to
 * container security policy or read-only filesystem constraints.
 */
export const CONSTRAINED_PROBES: Record<string, string> = {
    su: "privilege escalation is disabled by container security policy",
    sudo: "privilege escalation is disabled by container security policy",
    apt: "requires root and will fail — no sudo access and the container filesystem is read-only",
    docker: "not available — this environment runs inside a container, Docker and other container runtimes cannot be used from within",
};

/** Rendered when no tools, no scripting alternatives, no constrained present, and no absent tools are found. */
export const FALLBACK =
    "Warning: no shell tool information is available — the container may not have bootstrapped correctly. Use `which` <tool> to check whether a specific tool is present.";

// --- Pure functions ---

/**
 * Parses a JSONL string into Tool records.
 * Blank lines are skipped. Malformed lines are collected in skippedLines.
 */
export function parseTools(raw: string): { tools: Tool[]; skippedLines: string[] } {
    const tools: Tool[] = [];
    const skippedLines: string[] = [];
    for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let parsed: unknown;
        try {
            parsed = parseJson(trimmed);
        } catch {
            skippedLines.push(trimmed);
            continue;
        }
        const result = ToolSchema.safeParse(parsed);
        if (result.success) {
            tools.push(result.data);
        } else {
            skippedLines.push(trimmed);
        }
    }
    return { tools, skippedLines };
}

/** Renders a markdown table of registered tools. */
export function renderToolsTable(tools: Tool[]): string {
    const header = "| Tool | Usage | Description |\n|---|---|---|";
    const rows = tools.map((t) => `| \`${t.name}\` | \`${t.cmd}\` | ${t.desc} |`);
    return [header, ...rows].join("\n");
}

/**
 * Renders the "use bun" section for scripting tools that are absent but have
 * a bun-based alternative.
 */
export function renderScriptingAlternatives(entries: Array<{ name: string; message: string }>): string {
    const bullets = entries.map((e) => `- \`${e.name}\`: ${e.message}`);
    return `**The following scripting runtimes are not available in this container — see the suggested alternative for each:**\n${bullets.join("\n")}`;
}

/**
 * Renders the "do not use" section for constrained tools that are present
 * in the container but non-functional.
 */
export function renderConstrainedPresent(entries: Array<{ name: string; message: string }>): string {
    const bullets = entries.map((e) => `- \`${e.name}\`: ${e.message}`);
    return `**The following tools will not work in this container environment:**\n${bullets.join("\n")}`;
}

/** Renders the compact grouped line for all absent tools with no tailored message. */
export function renderAbsent(names: string[]): string {
    const list = names.map((n) => `\`${n}\``).join(", ");
    return `**Not available** (calls will result in \`command not found\`): ${list}`;
}

/**
 * Assembles the full rendered output under the ## Container shell tools heading.
 * Returns FALLBACK when all inputs are empty.
 */
export function render(
    tools: Tool[],
    scriptingAlternatives: Array<{ name: string; message: string }>,
    constrainedPresent: Array<{ name: string; message: string }>,
    allAbsent: string[],
): string {
    if (tools.length === 0 && scriptingAlternatives.length === 0 && constrainedPresent.length === 0 && allAbsent.length === 0) {
        return FALLBACK;
    }

    const parts: string[] = ["## Container shell tools"];

    if (tools.length > 0) {
        parts.push("Use the following tools — they are available in this container:");
        parts.push(renderToolsTable(tools));
    }
    if (scriptingAlternatives.length > 0) parts.push(renderScriptingAlternatives(scriptingAlternatives));
    if (constrainedPresent.length > 0) parts.push(renderConstrainedPresent(constrainedPresent));
    if (allAbsent.length > 0) parts.push(renderAbsent(allAbsent));

    return parts.join("\n\n");
}

// --- Script ---

export class RenderAddaShellTools extends ScriptBase<RenderAddaShellToolsDeps, EmptyArgs> {
    protected argDefinitions(): Parameters<typeof parseArgs>[0] {
        return { options: {}, strict: true };
    }

    protected validateArgs(_parsed: ReturnType<typeof parseArgs>): EmptyArgs {
        return {};
    }

    protected async execute(_args: EmptyArgs): Promise<void> {
        const home = this.deps.env.get("HOME");
        if (!home) throw new ScriptError("HOME environment variable is not set");
        const shellToolsPath = `${home}/.claude/shell-tools.jsonl`;

        const warnings: string[] = [];

        let raw: string;
        try {
            raw = await this.deps.fileReader.readFile(shellToolsPath);
        } catch {
            const readFileWarning =
                "Warning: ~/.claude/shell-tools.jsonl could not be read — the container may not have bootstrapped correctly. If you encounter unexpected tool availability issues, consider mentioning this to PO.";
            this.deps.stdio.stderr.write(`${readFileWarning}\n`);
            warnings.push(readFileWarning);
            raw = "";
        }

        const { tools, skippedLines } = parseTools(raw);

        if (skippedLines.length > 0) {
            const malformedWarning =
                "Warning: some entries in ~/.claude/shell-tools.jsonl were skipped due to malformed content. If tool availability seems incorrect, consider asking PO for guidance.";
            this.deps.stdio.stderr.write(`${malformedWarning}\n`);
            warnings.push(malformedWarning);
        }

        const registeredNames = new Set(tools.map((t) => t.name));
        const bunAvailable = registeredNames.has("bun");

        const scriptingAlternatives: Array<{ name: string; message: string }> = [];
        const allAbsent: string[] = [];

        for (const [name, bunMessage] of Object.entries(SCRIPTING_PROBES)) {
            const result = await this.deps.shell.run(["which", name], { strict: false });
            if (result.exitCode !== 0) {
                if (bunAvailable) {
                    scriptingAlternatives.push({ name, message: bunMessage });
                } else {
                    allAbsent.push(name);
                }
            }
            // present → silent
        }

        const constrainedPresent: Array<{ name: string; message: string }> = [];

        for (const [name, constraintMsg] of Object.entries(CONSTRAINED_PROBES)) {
            const result = await this.deps.shell.run(["which", name], { strict: false });
            if (result.exitCode === 0) {
                constrainedPresent.push({ name, message: constraintMsg });
            } else {
                allAbsent.push(name);
            }
        }

        const rendered = render(tools, scriptingAlternatives, constrainedPresent, allAbsent);

        const outputParts: string[] = [...warnings, rendered];
        this.deps.stdio.stdout.write(`${outputParts.join("\n\n")}\n`);
    }
}

if (import.meta.main) process.exit(await new RenderAddaShellTools(defaultDeps).run(process.argv));
