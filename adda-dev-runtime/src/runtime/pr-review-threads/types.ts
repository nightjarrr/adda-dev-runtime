// Types shared across pr-review-threads modules.
import type { BaseReason, GithubReason } from "@adda/lib";
import { ScriptError } from "@adda/lib";

// --- Error types ---

export type PrReviewThreadsReason = BaseReason | GithubReason | "scan_limit_exceeded";

export class PrReviewError extends ScriptError<PrReviewThreadsReason> {}

export type PrReviewThreadsArgs =
    | { mode: "pr"; prNumber: number; includeResolved: boolean; maxUnresolved: number }
    | { mode: "thread"; threadId: string };

// --- Comment shape ---

export interface ThreadComment {
    author: string;
    body: string;
    url: string;
    createdAt: string;
}

// --- Thread shape emitted in the file ---

export interface ThreadObject {
    id: string;
    path: string;
    line: number | null;
    startLine: number | null;
    originalLine: number | null;
    isResolved: boolean;
    isOutdated: boolean;
    diffSide: string;
    targetLine: string | null;
    hunkPreview: string | null;
    comments: ThreadComment[];
    commentsTruncated?: true;
    commentCount?: number;
}

// --- File header shapes ---

export interface PrFileHeader {
    number: number;
    total: number;
    unresolved: number;
    resolved: number;
    returnedUnresolved: number;
    moreUnresolvedAvailable: boolean;
    maxUnresolved: number;
}

export interface ThreadFileHeader {
    id: string;
    pr: number;
    isResolved: boolean;
    isOutdated: boolean;
    commentCount: number;
}

// --- Detail file shapes ---

export interface PrDetailFile {
    pr: PrFileHeader;
    threads: ThreadObject[];
    hunks: Record<string, string>;
}

export interface ThreadDetailFile {
    thread: ThreadFileHeader;
    threads: [ThreadObject];
    hunks: Record<string, string>;
}
