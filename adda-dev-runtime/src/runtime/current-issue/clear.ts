import type { ShellDep } from "@adda/lib";

import type { IssueStateStore, ScriptOutput } from "./types";
import { EMPTY_ISSUE_VIEW } from "./types";

export async function executeClear(deps: ShellDep, store: IssueStateStore, output: ScriptOutput): Promise<void> {
    if (!(await store.stateFileExists())) {
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
    output.emit({ status: "success", issue: EMPTY_ISSUE_VIEW, details: { branch: "main", resolution: "main" }, error: "" });
}
