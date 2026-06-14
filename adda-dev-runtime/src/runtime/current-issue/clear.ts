import type { FileSysDep, ScriptEnvelope, ShellDep } from "@adda/lib";

import { runRepoInitHook } from "./hook";
import { CurrentIssueError } from "./types";
import type { CurrentIssueResult, IssueStateStore } from "./types";
import { EMPTY_ISSUE_VIEW } from "./types";

export async function executeClear(
    skipRepoInit: boolean,
    deps: ShellDep & FileSysDep,
    store: IssueStateStore,
): Promise<ScriptEnvelope<CurrentIssueResult>> {
    if (!(await store.stateExists())) {
        return { status: "ok", result: { issue: EMPTY_ISSUE_VIEW, details: { resolution: "no-op" } }, error: null };
    }

    const statusResult = await deps.shell.run(["git", "status", "--porcelain"], { strict: false });
    if (statusResult.stdout.trim()) {
        throw new CurrentIssueError("dirty_tree", "working tree is dirty — commit or stash changes before clearing");
    }

    const checkoutResult = await deps.shell.run(["git", "checkout", "main"], { strict: false });
    if (checkoutResult.exitCode !== 0) {
        throw new CurrentIssueError("checkout_failed", checkoutResult.stderr.trim() || "git checkout main failed");
    }

    await store.deleteState();
    const hook = await runRepoInitHook(deps, skipRepoInit);
    return {
        status: "ok",
        result: { issue: EMPTY_ISSUE_VIEW, details: { branch: "main", resolution: "main", hook } },
        error: null,
    };
}
