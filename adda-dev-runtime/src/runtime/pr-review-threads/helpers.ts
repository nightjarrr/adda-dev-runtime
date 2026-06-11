// Pure helper functions for pr-review-threads.
import type { ThreadComment, ThreadObject } from "./types";
import type { CommentNode, ThreadNode } from "./graphql";

export const HUNK_PREVIEW_LINES = 7;
export const COMMENT_PREVIEW_DEPTH = 5;
export const FILE_PREFIX_PR = "pr-review-threads-pr";
export const FILE_PREFIX_THREAD = "pr-review-threads-thread";

/**
 * Sorts threads by (path, line ?? originalLine ?? 0).
 */
export function sortThreads(threads: ThreadNode[]): ThreadNode[] {
    return [...threads].sort((a, b) => {
        if (a.path < b.path) return -1;
        if (a.path > b.path) return 1;
        const aLine = a.line ?? a.originalLine ?? 0;
        const bLine = b.line ?? b.originalLine ?? 0;
        return aLine - bLine;
    });
}

/**
 * Maps a CommentNode to a ThreadComment (drops diffHunk — kept in hunks map).
 */
function toComment(c: CommentNode): ThreadComment {
    return { author: c.author.login, body: c.body, url: c.url, createdAt: c.createdAt };
}

/**
 * Splits a diff hunk into lines once and derives both the target line and
 * the hunk preview in a single pass.
 *
 * - targetLine: last non-empty line of the hunk (with +/-/space prefix).
 * - hunkPreview: @@ header dropped, last `tail` body lines kept; prefixed
 *   with "…" when lines were dropped. Null when the hunk body is empty.
 */
export function hunkToFields(
    hunk: string | null | undefined,
    tail = HUNK_PREVIEW_LINES,
): { targetLine: string | null; hunkPreview: string | null } {
    if (!hunk) return { targetLine: null, hunkPreview: null };
    const lines = hunk.split("\n");

    // targetLine: last non-empty line
    let targetLine: string | null = null;
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        if (line !== undefined && line.trim() !== "") {
            targetLine = line;
            break;
        }
    }

    // hunkPreview: drop @@ header (first line), drop trailing empty lines, clip to tail
    const body = lines.slice(1);
    while (body.length > 0 && body[body.length - 1]?.trim() === "") {
        body.pop();
    }
    let hunkPreview: string | null;
    if (body.length === 0) {
        hunkPreview = null;
    } else if (body.length <= tail) {
        hunkPreview = body.join("\n");
    } else {
        hunkPreview = `…\n${body.slice(body.length - tail).join("\n")}`;
    }

    return { targetLine, hunkPreview };
}

/**
 * Maps a ThreadNode to a ThreadObject for inclusion in the detail file.
 * Adds commentsTruncated + commentCount when comments were capped by preview depth.
 */
export function toThreadObject(node: ThreadNode): ThreadObject {
    const hunk = node.comments.nodes[0]?.diffHunk ?? null;
    const truncated = node.comments.totalCount > COMMENT_PREVIEW_DEPTH || node.comments.pageInfo.hasNextPage;
    const { targetLine, hunkPreview } = hunkToFields(hunk);
    const obj: ThreadObject = {
        id: node.id,
        path: node.path,
        line: node.line,
        startLine: node.startLine,
        originalLine: node.originalLine,
        isResolved: node.isResolved,
        isOutdated: node.isOutdated,
        diffSide: node.diffSide,
        targetLine,
        hunkPreview,
        comments: node.comments.nodes.map(toComment),
    };
    if (truncated) {
        obj.commentsTruncated = true;
        obj.commentCount = node.comments.totalCount;
    }
    return obj;
}

/**
 * Maps a set of CommentNode values (from thread-mode full pagination) to a
 * ThreadObject. The diffHunk comes from the first comment.
 */
export function toThreadObjectFull(
    node: {
        id: string;
        path: string;
        line: number | null | undefined;
        startLine: number | null | undefined;
        originalLine: number | null | undefined;
        isResolved: boolean;
        isOutdated: boolean;
        diffSide: string;
    },
    comments: CommentNode[],
): ThreadObject {
    const hunk = comments[0]?.diffHunk ?? null;
    const { targetLine, hunkPreview } = hunkToFields(hunk);
    return {
        id: node.id,
        path: node.path,
        line: node.line ?? null,
        startLine: node.startLine ?? null,
        originalLine: node.originalLine ?? null,
        isResolved: node.isResolved,
        isOutdated: node.isOutdated,
        diffSide: node.diffSide,
        targetLine,
        hunkPreview,
        comments: comments.map(toComment),
    };
}
