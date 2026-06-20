import type { CurrentIssueResult, IssueStateStore } from "./types";
import { EMPTY_FLAT_ISSUE_VIEW, EMPTY_ISSUE_VIEW } from "./types";

export async function executeShow(store: IssueStateStore, withHierarchy: boolean): Promise<CurrentIssueResult> {
    const state = await store.readState();
    if (!withHierarchy) {
        if (!state) return { issue: EMPTY_FLAT_ISSUE_VIEW, details: {} };
        const { parent: _p, children: _c, siblings: _s, ...flat } = state;
        return { issue: flat, details: {} };
    }
    return { issue: state ?? EMPTY_ISSUE_VIEW, details: {} };
}
