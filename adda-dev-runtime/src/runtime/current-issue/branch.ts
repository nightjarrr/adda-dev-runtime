import type { ShellDep } from "@adda/lib";
import { slugify } from "@adda/lib";

import { resolveIssueBranch } from "./resolve";
import type { IssueStateStore, ScriptOutput } from "./types";

async function getCurrentBranch(deps: ShellDep, output: ScriptOutput): Promise<string> {
    const result = await deps.shell.run(["git", "branch", "--show-current"], { strict: false });
    if (result.exitCode !== 0) {
        output.forwardStderr(result);
        output.fail(`git branch --show-current failed: ${result.stderr.trim()}`);
    }
    return result.stdout.trim();
}

export async function executeBranchEnsure(deps: ShellDep, store: IssueStateStore, output: ScriptOutput): Promise<void> {
    const state = await store.readState();
    if (!state) output.fail("no current issue set — run 'current-issue switch <id>' first");

    const resolveData = await resolveIssueBranch(deps, state.id, output);

    const currentBranch = await getCurrentBranch(deps, output);

    if (resolveData.status === "feature_branch") {
        if (currentBranch === resolveData.branch) {
            output.emit({
                status: "success",
                issue: state,
                details: { action: "none", branch: resolveData.branch },
                error: "",
            });
            return;
        }
        output.fail(
            `feature branch '${resolveData.branch}' already exists for issue #${state.id} but currently on '${currentBranch}'`,
        );
    }

    // resolveData.status === "main"
    if (currentBranch !== "main") {
        output.fail(`expected to be on 'main' to create feature branch, but currently on '${currentBranch}'`);
    }

    const rawSlug = slugify(state.title);
    let slug: string;
    let warning: string | undefined;
    if (!rawSlug) {
        slug = Math.random().toString(36).slice(2, 10);
        warning = `title '${state.title}' produced no slug; using random suffix '${slug}'`;
    } else {
        slug = rawSlug;
    }

    const branchName = `${state.type}/${state.id}-${slug}`;

    const developResult = await deps.shell.run(["gh", "issue", "develop", state.id, "-n", branchName, "--checkout"], {
        strict: false,
    });
    if (developResult.exitCode !== 0) {
        output.forwardStderr(developResult);
        output.fail(`gh issue develop failed for issue #${state.id}`);
    }

    const details: Record<string, unknown> = { action: "created", branch: branchName };
    if (warning) details.warning = warning;
    output.emit({ status: "success", issue: state, details, error: "" });
}

export async function executeBranchVerify(deps: ShellDep, store: IssueStateStore, output: ScriptOutput): Promise<void> {
    const state = await store.readState();
    if (!state) output.fail("no current issue set — run 'current-issue switch <id>' first");

    const resolveData = await resolveIssueBranch(deps, state.id, output);

    if (resolveData.status === "main") {
        output.fail(`no feature branch linked to issue #${state.id} — was 'current-issue branch --ensure' run?`);
    }

    const currentBranch = await getCurrentBranch(deps, output);

    if (currentBranch !== resolveData.branch) {
        output.fail(`expected branch '${resolveData.branch}' for issue #${state.id}, but currently on '${currentBranch}'`);
    }

    output.emit({ status: "success", issue: state, details: { branch: currentBranch }, error: "" });
}
