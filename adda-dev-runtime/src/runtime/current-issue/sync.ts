import type { EnvDep, FileSysDep, ShellDep } from "@adda/lib";

import { CurrentIssueError } from "./errors";
import { executeSwitch } from "./switch";
import type { IssueStateStore, SuccessEnvelope } from "./types";

export async function executeSync(
    skipRepoInit: boolean,
    deps: ShellDep & EnvDep & FileSysDep,
    store: IssueStateStore,
): Promise<SuccessEnvelope> {
    const state = await store.readState();
    if (!state || !state.id) {
        throw new CurrentIssueError("no active issue to sync");
    }
    return executeSwitch(state.id, skipRepoInit, deps, store);
}
