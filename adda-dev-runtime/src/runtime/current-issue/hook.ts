import type { FileSysDep, ShellDep } from "@adda/lib";

import { CurrentIssueError } from "./errors";
import type { HookResult } from "./types";

export const ADDA_INIT_HOOK_PATH = "/workspace/.adda-init.sh";

export async function runRepoInitHook(
    deps: ShellDep & FileSysDep,
    skip: boolean,
): Promise<Exclude<HookResult, { status: "failed" }>> {
    if (skip) return { status: "skipped" };
    if (!(await deps.fileSys.fileExists(ADDA_INIT_HOOK_PATH))) return { status: "absent" };
    const result = await deps.shell.run(["bash", ADDA_INIT_HOOK_PATH], { strict: false });
    const hookOutput = result.stdout + result.stderr;
    if (result.exitCode !== 0)
        throw new CurrentIssueError("repo init hook failed", { hook: { status: "failed" as const, output: hookOutput } });
    return { status: "ok", output: hookOutput };
}
