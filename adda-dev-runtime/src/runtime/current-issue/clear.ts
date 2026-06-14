import type { FileSysDep, ShellDep } from "@adda/lib";

import { runRepoInitHook } from "./hook";
import { CurrentIssueError } from "./types";
import type { CurrentIssueResult, IssueStateStore } from "./types";
import { EMPTY_ISSUE_VIEW } from "./types";

export async function executeClear(
    skipRepoInit: boolean,
    deps: ShellDep & FileSysDep,
    store: IssueStateStore,
): Promise<CurrentIssueResult> {
    if (!(await store.stateExists())) {
        return { issue: EMPTY_ISSUE_VIEW, details: { resolution: "no-op" } };
    }

    const statusResult = await deps.shell.run(["git", "status", "--porcelain"], { strict: false });
    if (statusResult.stdout.trim()) {
        throw new CurrentIssueError("dirty_tree", "working tree is dirty — commit or stash changes before clearing");
    }

    await deps.shell.run(["git", "checkout", "main"]);

    await store.deleteState();
    const hook = await runRepoInitHook(deps, skipRepoInit);
    return { issue: EMPTY_ISSUE_VIEW, details: { branch: "main", resolution: "main", hook } };
}
