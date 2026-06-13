import type { IssueStateStore, SuccessEnvelope } from "./types";
import { EMPTY_ISSUE_VIEW } from "./types";

export async function executeShow(store: IssueStateStore): Promise<SuccessEnvelope> {
    const state = await store.readState();
    return { status: "success", issue: state ?? EMPTY_ISSUE_VIEW, details: {}, error: "" };
}
