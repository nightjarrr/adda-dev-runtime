// issue-hierarchy — query and manage the sub-issue hierarchy of a GitHub issue.
//
// Usage:
//   issue-hierarchy children <issue-number>
//   issue-hierarchy parent <issue-number> [--set <number>]
//
// Inputs:
//   GITHUB_OWNER, GITHUB_REPO — required for all subcommands
//
// Outputs:
//   stdout: JSON envelope { status, result, error }
import type { parseArgs } from "node:util";
import type { EnvDep, ShellDep, StdioDep } from "@adda/lib";
import { defaultDeps, ScriptArgsError, ScriptBase } from "@adda/lib";

import { runChildren } from "./issue-hierarchy/children";
import { runParent } from "./issue-hierarchy/parent";
import { runSiblings } from "./issue-hierarchy/siblings";
import type { IssueHierarchyArgs } from "./issue-hierarchy/types";

export type { GitHubIssueHeader } from "@adda/lib";
export { fetchChildren } from "./issue-hierarchy/children";
export { fetchParent } from "./issue-hierarchy/parent";
export { fetchSiblings } from "./issue-hierarchy/siblings";

type IssueHierarchyDeps = ShellDep & EnvDep & StdioDep;

export class IssueHierarchyScript extends ScriptBase<IssueHierarchyDeps, IssueHierarchyArgs> {
    protected argDefinitions(): Parameters<typeof parseArgs>[0] {
        return {
            allowPositionals: true,
            strict: true,
            options: {
                set: { type: "string" },
            },
        };
    }

    protected validateArgs(parsed: ReturnType<typeof parseArgs>): IssueHierarchyArgs {
        const subcommand = parsed.positionals[0];
        if (!subcommand) {
            throw new ScriptArgsError(
                "subcommand is required: children <issue-number> | parent <issue-number> [--set <number>] | siblings <issue-number>",
            );
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

        if (subcommand === "parent") {
            const numberArg = parsed.positionals[1];
            if (!numberArg) {
                throw new ScriptArgsError("parent subcommand requires an issue number as the second argument");
            }
            const issueNumber = Number(numberArg);
            if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
                throw new ScriptArgsError(`invalid issue number '${numberArg}': must be a positive integer`);
            }

            const setRaw = parsed.values.set as string | undefined;
            let setParent: number | null | undefined;
            if (setRaw === undefined) {
                setParent = undefined; // read only
            } else if (setRaw.toUpperCase() === "NONE") {
                setParent = null; // remove
            } else {
                setParent = Number(setRaw);
                if (!Number.isInteger(setParent) || setParent <= 0) {
                    throw new ScriptArgsError(`invalid --set value '${setRaw}': must be a positive integer or 'NONE'`);
                }
            }

            return { subcommand: "parent", issueNumber, setParent };
        }

        if (subcommand === "siblings") {
            const numberArg = parsed.positionals[1];
            if (!numberArg) {
                throw new ScriptArgsError("siblings subcommand requires an issue number as the second argument");
            }
            const issueNumber = Number(numberArg);
            if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
                throw new ScriptArgsError(`invalid issue number '${numberArg}': must be a positive integer`);
            }
            return { subcommand: "siblings", issueNumber };
        }

        throw new ScriptArgsError(`unknown subcommand '${subcommand}': expected 'children', 'parent', or 'siblings'`);
    }

    protected async execute(args: IssueHierarchyArgs): Promise<void> {
        if (args.subcommand === "children") {
            const result = await runChildren(this.deps, args);
            this.emitOk(result);
        } else if (args.subcommand === "siblings") {
            const result = await runSiblings(this.deps, args);
            this.emitOk(result);
        } else {
            const result = await runParent(this.deps, args);
            this.emitOk(result);
        }
    }
}

if (import.meta.main) process.exit(await new IssueHierarchyScript(defaultDeps).run(process.argv));
