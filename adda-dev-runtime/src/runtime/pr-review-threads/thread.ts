// thread mode handler for pr-review-threads.
import type { EnvDep, ShellDep } from "@adda/lib";
import { ScriptError, ScriptZodValidationError } from "@adda/lib";
import { THREAD_NODE_QUERY, ThreadNodeQuerySchema } from "./graphql";
import type { CommentNode } from "./graphql";
import { FILE_PREFIX_THREAD, toThreadObjectFull } from "./helpers";
import { classifyError, Output } from "./output";
import { graphql, paginate, readCeiling } from "./fetch";
import type { PrReviewThreadsArgs, ThreadDetailFile, ThreadFileHeader } from "./types";

type ThreadDeps = ShellDep & EnvDep;

/**
 * Handles thread mode: fetches a single review thread and all its comments,
 * builds the detail file, and emits the success envelope.
 */
export async function runThread(
    deps: ThreadDeps,
    args: Extract<PrReviewThreadsArgs, { mode: "thread" }>,
    output: Output,
): Promise<void> {
    try {
        await runThreadInner(deps, args, output);
    } catch (err) {
        if (!output.hasEmitted) {
            const message = err instanceof Error ? err.message : String(err);
            output.emitModeError("thread", classifyError(err), message);
        }
        throw err;
    }
}

async function runThreadInner(
    deps: ThreadDeps,
    args: Extract<PrReviewThreadsArgs, { mode: "thread" }>,
    output: Output,
): Promise<void> {
    const ceiling = readCeiling(deps);

    // Fetch first page for domain checks before full pagination
    const firstRaw = await graphql(deps, { id: args.threadId, after: null }, THREAD_NODE_QUERY);
    const firstParsed = ThreadNodeQuerySchema.safeParse(firstRaw);
    if (!firstParsed.success)
        throw new ScriptZodValidationError("unexpected thread node response", firstParsed.error, firstRaw);

    const node = firstParsed.data.data.node;
    if (node === null) {
        output.emitModeError("thread", "thread_not_found", `thread '${args.threadId}' not found`);
        throw new ScriptError(`thread '${args.threadId}' not found`);
    }
    if (node.__typename !== "PullRequestReviewThread") {
        output.emitModeError(
            "thread",
            "not_a_thread",
            `node '${args.threadId}' is not a PullRequestReviewThread (got ${node.__typename})`,
        );
        throw new ScriptError(`node '${args.threadId}' is not a PullRequestReviewThread`);
    }

    const comments = node.comments;
    if (!comments) throw new ScriptError("unexpected missing comments on PullRequestReviewThread node");
    const pullRequest = node.pullRequest;
    if (!pullRequest) throw new ScriptError("unexpected missing pullRequest on PullRequestReviewThread node");

    const commentCount = comments.totalCount;
    if (commentCount > ceiling) {
        output.emitScanLimitExceeded("thread", undefined, commentCount, ceiling);
        throw new ScriptError(`scan limit exceeded: ${commentCount} comments > ceiling ${ceiling}`, 1);
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

    const resultsFile = await output.writeDetailFile<ThreadDetailFile>(FILE_PREFIX_THREAD, {
        thread: header,
        threads: [threadObj],
        hunks,
    });

    output.emitSuccess({ status: "success", error: "", thread: { ...header, resultsFile } });
}
