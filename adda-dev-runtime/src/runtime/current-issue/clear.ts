import type { FileSysDep, ShellDep } from "@adda/lib";

import { CurrentIssueError } from "./errors";
import { runRepoInitHook } from "./hook";
import type { IssueStateStore, SuccessEnvelope } from "./types";
import { EMPTY_ISSUE_VIEW } from "./types";

export async function executeClear(
    skipRepoInit: boolean,
    deps: ShellDep & FileSysDep,
    store: IssueStateStore,
): Promise<SuccessEnvelope> {
    if (!(await store.stateExists())) {
        return { status: "success", issue: EMPTY_ISSUE_VIEW, details: { resolution: "no-op" }, error: "" };
    }

    const statusResult = await deps.shell.run(["git", "status", "--porcelain"], { strict: false });
    if (statusResult.stdout.trim()) {
        throw new CurrentIssueError("working tree is dirty — commit or stash changes before clearing");
    }

    const checkoutResult = await deps.shell.run(["git", "checkout", "main"], { strict: false });
    if (checkoutResult.exitCode !== 0) {
        throw new CurrentIssueError(checkoutResult.stderr.trim() || "git checkout main failed");
    }

    await store.deleteState();
    const hook = await runRepoInitHook(deps, skipRepoInit);
    return {
        status: "success",
        issue: EMPTY_ISSUE_VIEW,
        details: { branch: "main", resolution: "main", hook },
        error: "",
    };
}
