import type { ScriptEnvelope, ShellDep } from "@adda/lib";
import { slugify } from "@adda/lib";

import { CurrentIssueError } from "./errors";
import { resolveIssueBranch } from "./resolve";
import type { CurrentIssueResult, IssueStateStore } from "./types";

async function getCurrentBranch(deps: ShellDep): Promise<string> {
    const result = await deps.shell.run(["git", "branch", "--show-current"], { strict: false });
    if (result.exitCode !== 0) {
        throw new CurrentIssueError("shell_error", `git branch --show-current failed: ${result.stderr.trim()}`, result.stderr);
    }
    return result.stdout.trim();
}

export async function executeBranchEnsure(deps: ShellDep, store: IssueStateStore): Promise<ScriptEnvelope<CurrentIssueResult>> {
    const state = await store.readState();
    if (!state) throw new CurrentIssueError("no_current_issue", "no current issue set — run 'current-issue switch <id>' first");

    const resolveData = await resolveIssueBranch(deps, state.id);

    const currentBranch = await getCurrentBranch(deps);

    if (resolveData.resolution === "feature_branch") {
        if (currentBranch === resolveData.branch) {
            return {
                status: "ok",
                result: { issue: state, details: { action: "none", branch: resolveData.branch } },
                error: null,
            };
        }
        throw new CurrentIssueError(
            "branch_mismatch",
            `feature branch '${resolveData.branch}' already exists for issue #${state.id} but currently on '${currentBranch}'`,
        );
    }

    // resolveData.resolution === "main"
    if (currentBranch !== "main") {
        throw new CurrentIssueError(
            "branch_mismatch",
            `expected to be on 'main' to create feature branch, but currently on '${currentBranch}'`,
        );
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
        throw new CurrentIssueError(
            "branch_create_failed",
            `gh issue develop failed for issue #${state.id}`,
            developResult.stderr,
        );
    }

    const details: Record<string, unknown> = { action: "created", branch: branchName };
    if (warning) details.warning = warning;
    return { status: "ok", result: { issue: state, details }, error: null };
}

export async function executeBranchVerify(deps: ShellDep, store: IssueStateStore): Promise<ScriptEnvelope<CurrentIssueResult>> {
    const state = await store.readState();
    if (!state) throw new CurrentIssueError("no_current_issue", "no current issue set — run 'current-issue switch <id>' first");

    const resolveData = await resolveIssueBranch(deps, state.id);

    if (resolveData.resolution === "main") {
        throw new CurrentIssueError(
            "no_feature_branch",
            `no feature branch linked to issue #${state.id} — was 'current-issue branch --ensure' run?`,
        );
    }

    const currentBranch = await getCurrentBranch(deps);

    if (currentBranch !== resolveData.branch) {
        throw new CurrentIssueError(
            "branch_mismatch",
            `expected branch '${resolveData.branch}' for issue #${state.id}, but currently on '${currentBranch}'`,
        );
    }

    return { status: "ok", result: { issue: state, details: { branch: currentBranch } }, error: null };
}
