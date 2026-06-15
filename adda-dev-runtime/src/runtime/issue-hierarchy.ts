// issue-hierarchy — query the sub-issue hierarchy of a GitHub issue.
//
// Usage:
//   issue-hierarchy children <issue-number>
//
// Inputs:
//   GITHUB_OWNER, GITHUB_REPO — required for children subcommand
//
// Outputs:
//   stdout: JSON envelope { status, result: { parent, children }, error }
import type { parseArgs } from "node:util";
import type { EnvDep, ShellDep, StdioDep } from "@adda/lib";
import { defaultDeps, ScriptArgsError, ScriptBase } from "@adda/lib";

import { runChildren } from "./issue-hierarchy/children";
import type { IssueHierarchyArgs } from "./issue-hierarchy/types";

type IssueHierarchyDeps = ShellDep & EnvDep & StdioDep;

export class IssueHierarchyScript extends ScriptBase<IssueHierarchyDeps, IssueHierarchyArgs> {
    protected argDefinitions(): Parameters<typeof parseArgs>[0] {
        return {
            allowPositionals: true,
            strict: true,
            options: {},
        };
    }

    protected validateArgs(parsed: ReturnType<typeof parseArgs>): IssueHierarchyArgs {
        const subcommand = parsed.positionals[0];
        if (!subcommand) {
            throw new ScriptArgsError("subcommand is required: children <issue-number>");
        }

        if (subcommand === "children") {
            const numberArg = parsed.positionals[1];
            if (!numberArg) {
                throw new ScriptArgsError("children subcommand requires an issue number as the second argument");
            }
            const parentNumber = Number(numberArg);
            if (!Number.isInteger(parentNumber) || parentNumber <= 0) {
                throw new ScriptArgsError(`invalid issue number '${numberArg}': must be a positive integer`);
            }
            return { subcommand: "children", parentNumber };
        }

        throw new ScriptArgsError(`unknown subcommand '${subcommand}': expected 'children'`);
    }

    protected async execute(args: IssueHierarchyArgs): Promise<void> {
        const result = await runChildren(this.deps, args);
        this.emitOk(result);
    }
}

if (import.meta.main) process.exit(await new IssueHierarchyScript(defaultDeps).run(process.argv));
