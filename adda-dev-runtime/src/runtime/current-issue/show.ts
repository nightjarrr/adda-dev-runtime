import type { CurrentIssueResult, IssueStateStore } from "./types";
import { EMPTY_ISSUE_VIEW } from "./types";

export async function executeShow(store: IssueStateStore): Promise<CurrentIssueResult> {
    const state = await store.readState();
    return { issue: state ?? EMPTY_ISSUE_VIEW, details: {} };
}
