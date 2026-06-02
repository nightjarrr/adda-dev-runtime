import { homedir } from "node:os";
import type { parseArgs } from "node:util";
import type { EmptyArgs, FileReaderDep, ShellDep, StdioDep } from "@adda/lib";
import { defaultDeps, ScriptBase } from "@adda/lib";

// --- Types ---

export type Tool = { name: string; cmd: string; desc: string };

type RenderAddaShellToolsDeps = FileReaderDep & ShellDep & StdioDep;

// --- Constants ---

/** Tools to probe for absence — familiar names that are not installed in Tier 1/2. */
export const TOOL_PROBES: string[] = ["python", "python3", "docker", "apt", "pip", "npm", "node"];

/**
 * Appended after the missing-tools section when no tools table was rendered,
 * to guide the agent toward the registered alternatives.
 */
export const PROBE_HINT = "Load the `adda-shell-tools` skill to see which tools are registered and available.";

/** Rendered when neither registered tools nor missing tools are found. */
export const FALLBACK = "No shell tool information is available. Load the `adda-shell-tools` skill for guidance.";

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

/** Renders the missing-tools section with one line per absent tool. */
export function renderMissingTools(missing: string[]): string {
    const lines = missing.map((name) => `- \`${name}\` is not available — use available tools only for smooth operation`);
    return `**Absent tools:**\n${lines.join("\n")}`;
}

/**
 * Composes the full rendered output from tools and missing lists.
 * Returns FALLBACK when both are empty.
 */
export function render(tools: Tool[], missing: string[]): string {
    const toolsSection = tools.length > 0 ? renderToolsTable(tools) : null;
    const missingSection = missing.length > 0 ? renderMissingTools(missing) : null;

    if (!toolsSection && !missingSection) return FALLBACK;

    const parts: string[] = [];
    if (toolsSection) parts.push(toolsSection);
    if (missingSection) parts.push(missingSection);
    if (!toolsSection) parts.push(PROBE_HINT);

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

        const missing: string[] = [];
        for (const toolName of TOOL_PROBES) {
            const result = await this.deps.shell.run(["which", toolName], { strict: false });
            if (result.exitCode !== 0) {
                missing.push(toolName);
            }
        }

        const output = render(tools, missing);
        this.deps.stdio.stdout.write(`${output}\n`);
    }
}

if (import.meta.main) process.exit(await new RenderAddaShellTools(defaultDeps).run(process.argv));
