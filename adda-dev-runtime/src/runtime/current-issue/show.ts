import type { IssueStateStore, ScriptOutput } from "./types";
import { EMPTY_ISSUE_VIEW } from "./types";

export async function executeShow(store: IssueStateStore, output: ScriptOutput): Promise<void> {
    const state = await store.readState();
    output.emit({ status: "success", issue: state ?? EMPTY_ISSUE_VIEW, details: {}, error: "" });
}
