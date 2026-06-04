import type { FileSysDep, ShellDep } from "@adda/lib";

import { runRepoInitHook } from "./hook";
import type { IssueStateStore, ScriptOutput } from "./types";
import { EMPTY_ISSUE_VIEW } from "./types";

export async function executeClear(
    skipRepoInit: boolean,
    deps: ShellDep & FileSysDep,
    store: IssueStateStore,
    output: ScriptOutput,
): Promise<void> {
    if (!(await store.stateExists())) {
        output.emit({ status: "success", issue: EMPTY_ISSUE_VIEW, details: { resolution: "no-op" }, error: "" });
        return;
    }

    const statusResult = await deps.shell.run(["git", "status", "--porcelain"], { strict: false });
    if (statusResult.stdout.trim()) {
        output.fail("working tree is dirty — commit or stash changes before clearing");
    }

    const checkoutResult = await deps.shell.run(["git", "checkout", "main"], { strict: false });
    if (checkoutResult.exitCode !== 0) {
        output.fail(checkoutResult.stderr.trim() || "git checkout main failed");
    }

    await store.deleteState();
    const hook = await runRepoInitHook(deps, skipRepoInit);
    if (hook.status === "failed") output.fail("repo init hook failed", { hook });
    output.emit({
        status: "success",
        issue: EMPTY_ISSUE_VIEW,
        details: { branch: "main", resolution: "main", hook },
        error: "",
    });
}
