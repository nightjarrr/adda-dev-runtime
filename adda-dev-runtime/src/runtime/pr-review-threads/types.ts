// Types shared across pr-review-threads modules.

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

// --- Envelope shapes ---

export interface PrEnvelope {
    status: "success" | "error";
    error: string;
    pr?: (PrFileHeader & { resultsFile?: string }) | { reason: string; total?: number; ceiling?: number };
}

export interface ThreadEnvelope {
    status: "success" | "error";
    error: string;
    thread?: (ThreadFileHeader & { resultsFile?: string }) | { reason: string; commentCount?: number; ceiling?: number };
}

export type Envelope = PrEnvelope | ThreadEnvelope | { status: "error"; error: string };
