import { homedir } from "node:os";
import type { parseArgs } from "node:util";
import type { EmptyArgs, FileReaderDep, ShellDep, StdioDep } from "@adda/lib";
import { defaultDeps, ScriptBase } from "@adda/lib";

// --- Types ---

export type Tool = { name: string; cmd: string; desc: string };

type RenderAddaShellToolsDeps = FileReaderDep & ShellDep & StdioDep;

// --- Constants ---

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
    apt: "package installation fails — the container filesystem is read-only",
    docker: "Docker daemon is not accessible in this container",
};

/** Rendered when no tools, no scripting alternatives, no constrained present, and no absent tools are found. */
export const FALLBACK = "No shell tool information is available for this container.";

// --- Pure functions ---

/**
 * Parses a JSONL string into Tool records.
 * Blank lines and malformed lines are silently skipped.
 */
export function parseTools(raw: string): Tool[] {
    const tools: Tool[] = [];
    for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
            const obj = JSON.parse(trimmed) as Record<string, unknown>;
            if (typeof obj.name === "string" && typeof obj.cmd === "string" && typeof obj.desc === "string") {
                tools.push({ name: obj.name, cmd: obj.cmd, desc: obj.desc });
            }
        } catch {
            // skip malformed lines
        }
    }
    return tools;
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
    return `**Scripting runtimes not available — use bun:**\n${bullets.join("\n")}`;
}

/**
 * Renders the "do not use" section for constrained tools that are present
 * in the container but non-functional.
 */
export function renderConstrainedPresent(entries: Array<{ name: string; message: string }>): string {
    const bullets = entries.map((e) => `- \`${e.name}\`: ${e.message}`);
    return `**Do not use — blocked by container:**\n${bullets.join("\n")}`;
}

/** Renders the compact grouped line for all absent tools with no tailored message. */
export function renderAbsent(names: string[]): string {
    const list = names.map((n) => `\`${n}\``).join(", ");
    return `**Not available:** ${list}`;
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

    if (tools.length > 0) parts.push(renderToolsTable(tools));
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
        const shellToolsPath = `${homedir()}/.claude/shell-tools.jsonl`;

        let raw: string;
        try {
            raw = await this.deps.fileReader.readFile(shellToolsPath);
        } catch {
            raw = "";
        }

        const tools = parseTools(raw);
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

        const output = render(tools, scriptingAlternatives, constrainedPresent, allAbsent);
        this.deps.stdio.stdout.write(`${output}\n`);
    }
}

if (import.meta.main) process.exit(await new RenderAddaShellTools(defaultDeps).run(process.argv));
