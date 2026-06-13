// thread mode handler for pr-review-threads.
import type { EnvDep, ShellDep } from "@adda/lib";
import { atomicWriteFile, ScriptError, ScriptZodValidationError } from "@adda/lib";
import { THREAD_NODE_QUERY, ThreadNodeQuerySchema } from "./graphql";
import type { CommentNode } from "./graphql";
import { FILE_PREFIX_THREAD, toThreadObjectFull } from "./helpers";
import { graphql, paginate, readCeiling } from "./fetch";
import type { PrReviewThreadsArgs, ThreadDetailFile, ThreadFileHeader } from "./types";

type ThreadDeps = ShellDep & EnvDep;

type ThreadResult = { header: ThreadFileHeader; resultsFile: string };

/**
 * Handles thread mode: fetches a single review thread and all its comments,
 * builds the detail file, and returns the result.
 */
export async function runThread(
    deps: ThreadDeps,
    args: Extract<PrReviewThreadsArgs, { mode: "thread" }>,
): Promise<ThreadResult> {
    return runThreadInner(deps, args);
}

async function runThreadInner(deps: ThreadDeps, args: Extract<PrReviewThreadsArgs, { mode: "thread" }>): Promise<ThreadResult> {
    const ceiling = readCeiling(deps);

    // Fetch first page for domain checks before full pagination
    const firstRaw = await graphql(deps, { id: args.threadId, after: null }, THREAD_NODE_QUERY);
    const firstParsed = ThreadNodeQuerySchema.safeParse(firstRaw);
    if (!firstParsed.success)
        throw new ScriptZodValidationError("unexpected thread node response", firstParsed.error, firstRaw);

    const node = firstParsed.data.data.node;
    if (node === null) {
        throw new ScriptError(`thread '${args.threadId}' not found`, 1, "thread_not_found");
    }
    if (node.__typename !== "PullRequestReviewThread") {
        throw new ScriptError(
            `node '${args.threadId}' is not a PullRequestReviewThread (got ${node.__typename})`,
            1,
            "not_a_thread",
        );
    }

    const comments = node.comments;
    if (!comments) throw new ScriptError("unexpected missing comments on PullRequestReviewThread node");
    const pullRequest = node.pullRequest;
    if (!pullRequest) throw new ScriptError("unexpected missing pullRequest on PullRequestReviewThread node");

    const commentCount = comments.totalCount;
    if (commentCount > ceiling) {
        throw new ScriptError(`scan limit exceeded: ${commentCount} comments > ceiling ${ceiling}`, 1, "scan_limit_exceeded", {
            commentCount,
            ceiling,
        });
    }

    if (
        node.path === undefined ||
        node.isResolved === undefined ||
        node.isOutdated === undefined ||
        node.diffSide === undefined
    )
        throw new ScriptError("unexpected missing fields on PullRequestReviewThread node");

    // Collect all comments using shared paginator
    const allComments: CommentNode[] = await paginate(
        deps,
        comments.nodes,
        comments.pageInfo,
        { id: args.threadId },
        THREAD_NODE_QUERY,
        ThreadNodeQuerySchema,
        (parsed) => {
            const pageComments = parsed.data.node?.comments;
            return pageComments ?? null;
        },
        "unexpected thread comments",
    );

    const prNumber = pullRequest.number;
    const threadObj = toThreadObjectFull(
        {
            id: args.threadId,
            path: node.path,
            line: node.line,
            startLine: node.startLine,
            originalLine: node.originalLine,
            isResolved: node.isResolved,
            isOutdated: node.isOutdated,
            diffSide: node.diffSide,
        },
        allComments,
    );

    const hunk = allComments[0]?.diffHunk;
    const hunks: Record<string, string> = {};
    if (hunk) hunks[args.threadId] = hunk;

    const header: ThreadFileHeader = {
        id: args.threadId,
        pr: prNumber,
        isResolved: node.isResolved,
        isOutdated: node.isOutdated,
        commentCount,
    };

    const resultsFile = await atomicWriteFile(
        `<tmpDir>/${FILE_PREFIX_THREAD}-<ts>.json`,
        JSON.stringify({ thread: header, threads: [threadObj], hunks } satisfies ThreadDetailFile, null, 2),
    );

    return { header, resultsFile };
}
