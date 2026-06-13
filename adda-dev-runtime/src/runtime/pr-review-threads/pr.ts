// pr mode handler for pr-review-threads.
import type { EnvDep, FileSysDep, FileWriterDep, ShellDep, StdioDep, TmpDep } from "@adda/lib";
import { ScriptError, ScriptZodValidationError, writeDetailFile } from "@adda/lib";
import { PR_THREADS_QUERY, PrThreadsPageSchema } from "./graphql";
import type { ThreadNode } from "./graphql";
import { COMMENT_PREVIEW_DEPTH, FILE_PREFIX_PR, sortThreads, toThreadObject } from "./helpers";
import { runMode } from "./errors";
import { graphql, paginate, readCeiling, requireOwnerRepo } from "./fetch";
import type { PrDetailFile, PrFileHeader, PrReviewThreadsArgs, ThreadObject } from "./types";

type PrDeps = ShellDep & EnvDep & StdioDep & TmpDep & FileWriterDep & FileSysDep;

type PrSuccessEnvelope = { status: "success"; error: string; pr: PrFileHeader & { resultsFile: string } };

/**
 * Handles pr mode: fetches all review threads for a PR, classifies/sorts/windows,
 * builds the detail file, and returns the success envelope.
 */
export async function runPr(deps: PrDeps, args: Extract<PrReviewThreadsArgs, { mode: "pr" }>): Promise<PrSuccessEnvelope> {
    let result!: PrSuccessEnvelope;
    await runMode("pr", () =>
        runPrInner(deps, args).then((r) => {
            result = r;
        }),
    );
    return result;
}

async function runPrInner(deps: PrDeps, args: Extract<PrReviewThreadsArgs, { mode: "pr" }>): Promise<PrSuccessEnvelope> {
    const ceiling = readCeiling(deps);
    const { owner, repo } = requireOwnerRepo(deps);

    // Fetch first page to perform domain checks before full pagination
    const firstRaw = await graphql(deps, { owner, repo, number: args.prNumber, after: null }, PR_THREADS_QUERY);
    const firstParsed = PrThreadsPageSchema.safeParse(firstRaw);
    if (!firstParsed.success) throw new ScriptZodValidationError("unexpected PR threads response", firstParsed.error, firstRaw);

    if (firstParsed.data.data.repository === null) {
        throw new ScriptError(`repository ${owner}/${repo} not found`, 1, "repo_not_found");
    }
    if (firstParsed.data.data.repository.pullRequest === null) {
        throw new ScriptError(`PR #${args.prNumber} not found in ${owner}/${repo}`, 1, "pr_not_found");
    }

    const firstPage = firstParsed.data.data.repository.pullRequest.reviewThreads;
    const total = firstPage.totalCount;

    if (total > ceiling) {
        throw new ScriptError(`scan limit exceeded: ${total} threads > ceiling ${ceiling}`, 1, "scan_limit_exceeded", {
            total,
            ceiling,
        });
    }

    // Collect all pages using shared paginator
    const allNodes: ThreadNode[] = await paginate(
        deps,
        firstPage.nodes,
        firstPage.pageInfo,
        { owner, repo, number: args.prNumber },
        PR_THREADS_QUERY,
        PrThreadsPageSchema,
        (parsed) => parsed.data.repository?.pullRequest?.reviewThreads ?? null,
        "unexpected PR threads response",
    );

    // Classify and window
    const unresolvedThreads = sortThreads(allNodes.filter((n) => !n.isResolved));
    const resolvedThreads = sortThreads(allNodes.filter((n) => n.isResolved));

    const unresolved = unresolvedThreads.length;
    const resolved = resolvedThreads.length;
    const returnedUnresolved = Math.min(args.maxUnresolved, unresolved);
    const moreUnresolvedAvailable = unresolved > returnedUnresolved;

    const windowed = unresolvedThreads.slice(0, returnedUnresolved);
    const emitted = args.includeResolved ? [...windowed, ...resolvedThreads] : windowed;

    // Warn on truncated comment threads
    const truncatedIds: string[] = [];
    for (const node of emitted) {
        if (node.comments.totalCount > COMMENT_PREVIEW_DEPTH || node.comments.pageInfo.hasNextPage) {
            truncatedIds.push(node.id);
        }
    }
    if (truncatedIds.length > 0) {
        deps.stdio.stderr.write(
            `Warning: ${truncatedIds.length} thread(s) have truncated comments (>5); use 'thread <id>' to fetch all comments. Affected: ${truncatedIds.join(", ")}\n`,
        );
    }

    // Build output
    const threads: ThreadObject[] = emitted.map(toThreadObject);
    const hunks: Record<string, string> = {};
    for (const node of emitted) {
        const hunk = node.comments.nodes[0]?.diffHunk;
        if (hunk) hunks[node.id] = hunk;
    }

    const header: PrFileHeader = {
        number: args.prNumber,
        total,
        unresolved,
        resolved,
        returnedUnresolved,
        moreUnresolvedAvailable,
        maxUnresolved: args.maxUnresolved,
    };

    const resultsFile = await writeDetailFile<PrDetailFile>(deps, `${FILE_PREFIX_PR}-${args.prNumber}`, {
        pr: header,
        threads,
        hunks,
    });

    return { status: "success" as const, error: "", pr: { ...header, resultsFile } };
}
