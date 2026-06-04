import type { FileSysDep, ShellDep } from "@adda/lib";

import type { HookResult } from "./types";

export const ADDA_INIT_HOOK_PATH = "/workspace/.adda-init.sh";

export async function runRepoInitHook(deps: ShellDep & FileSysDep, skip: boolean): Promise<HookResult> {
    if (skip) return { status: "skipped" };
    if (!(await deps.fileSys.fileExists(ADDA_INIT_HOOK_PATH))) return { status: "absent" };
    const result = await deps.shell.run(["bash", ADDA_INIT_HOOK_PATH], { strict: false });
    const output = result.stdout + result.stderr;
    return result.exitCode !== 0 ? { status: "failed", output } : { status: "ok", output };
}
