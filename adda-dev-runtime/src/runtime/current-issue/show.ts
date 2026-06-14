import type { ScriptEnvelope } from "@adda/lib";

import type { CurrentIssueResult, IssueStateStore } from "./types";
import { EMPTY_ISSUE_VIEW } from "./types";

export async function executeShow(store: IssueStateStore): Promise<ScriptEnvelope<CurrentIssueResult>> {
    const state = await store.readState();
    return { status: "ok", result: { issue: state ?? EMPTY_ISSUE_VIEW, details: {} }, error: null };
}
