import type { FileSysDep, ShellDep, ShellResult } from "@adda/lib";
import { ScriptShellError } from "@adda/lib";

import { CurrentIssueError } from "./types";
import type { HookResult } from "./types";

export const ADDA_INIT_HOOK_PATH = "/workspace/.adda-init.sh";

export async function runRepoInitHook(
    deps: ShellDep & FileSysDep,
    skip: boolean,
): Promise<Exclude<HookResult, { status: "failed" }>> {
    if (skip) return { status: "skipped" };
    if (!(await deps.fileSys.fileExists(ADDA_INIT_HOOK_PATH))) return { status: "absent" };
    let result: ShellResult;
    try {
        result = await deps.shell.run(["bash", ADDA_INIT_HOOK_PATH]);
    } catch (e) {
        if (!(e instanceof ScriptShellError)) throw e;
        const errorDetails = e.envelope.status === "fail" ? e.envelope.error.details : {};
        const stdoutPart = String(errorDetails?.stdout ?? "");
        const hookOutput = (stdoutPart !== "(empty)" ? stdoutPart + "\n" : "") + (e.verboseStderr ?? "");
        throw new CurrentIssueError("hook_failed", "repo init hook failed", {
            details: { hook: { status: "failed" as const, output: hookOutput.trim() } },
        });
    }
    const hookOutput = result.stdout + result.stderr;
    return { status: "ok", output: hookOutput };
}
