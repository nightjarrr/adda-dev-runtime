import type { EnvDep, FileSysDep, ShellDep } from "@adda/lib";

import { executeSwitch } from "./switch";
import type { IssueStateStore, ScriptOutput } from "./types";

export async function executeSync(
    deps: ShellDep & EnvDep & FileSysDep,
    store: IssueStateStore,
    output: ScriptOutput,
): Promise<void> {
    const state = await store.readState();
    if (!state || !state.id) {
        output.fail("no active issue to sync");
    }
    await executeSwitch(state.id, false, deps, store, output);
}
