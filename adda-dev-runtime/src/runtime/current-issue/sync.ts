import type { EnvDep, FileSysDep, ShellDep } from "@adda/lib";

import { executeSwitch } from "./switch";
import { CurrentIssueError } from "./types";
import type { CurrentIssueResult, IssueStateStore } from "./types";

export async function executeSync(
    skipRepoInit: boolean,
    deps: ShellDep & EnvDep & FileSysDep,
    store: IssueStateStore,
): Promise<CurrentIssueResult> {
    const state = await store.readState();
    if (!state || !state.id) {
        throw new CurrentIssueError("no_active_issue", "no active issue to sync");
    }
    return executeSwitch(state.id, skipRepoInit, deps, store);
}
