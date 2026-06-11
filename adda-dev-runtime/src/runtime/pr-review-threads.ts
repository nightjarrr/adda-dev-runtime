// pr-review-threads — query open PR review threads via GitHub GraphQL.
//
// Usage:
//   pr-review-threads pr <pr-number> [--include-resolved] [--max-unresolved <n>]
//   pr-review-threads thread <thread-id>
//
// Inputs:
//   GITHUB_OWNER, GITHUB_REPO — required for pr mode
//   ADDA_DEV_PR_REVIEW_SCAN_CEILING — optional; positive int; default 1000
//
// Outputs:
//   stdout: JSON envelope (mode-keyed: .pr or .thread)
//   file:   detail file at /tmp/pr-review-threads-{pr|thread}-…-<epoch-ms>.json
import type { parseArgs } from "node:util";
import type { EnvDep, FileWriterDep, FileSysDep, ShellDep, StdioDep, TmpDep } from "@adda/lib";
import {
    ConfigError,
    defaultDeps,
    parseJson,
    ScriptArgsError,
    ScriptBase,
    ScriptError,
    ScriptZodValidationError,
} from "@adda/lib";

// Reason codes used in error envelopes
const REASON_MISSING_ENV = "missing_env";
const REASON_INVALID_CONFIG = "invalid_config";
const REASON_GRAPHQL_ERROR = "graphql_error";
const REASON_INTERNAL_ERROR = "internal_error";

/**
 * Classify an unhandled error into a short reason code for the structured envelope.
 * Errors that are already explicitly handled (and have envelopeEmitted = true) should
 * not reach this function, but it is kept general for safety.
 */
function classifyError(err: unknown): string {
    if (err instanceof ConfigError) return REASON_INVALID_CONFIG;
    if (err instanceof Error) {
        if (err.message.startsWith("required environment variable")) return REASON_MISSING_ENV;
        if (err.message.startsWith("GraphQL API call failed")) return REASON_GRAPHQL_ERROR;
    }
    return REASON_INTERNAL_ERROR;
}
import { PR_THREADS_QUERY, PrThreadsPageSchema, THREAD_NODE_QUERY, ThreadNodeQuerySchema } from "./pr-review-threads/graphql";
import type { CommentNode, ThreadNode } from "./pr-review-threads/graphql";
import {
    COMMENT_PREVIEW_DEPTH,
    FILE_PREFIX_PR,
    FILE_PREFIX_THREAD,
    sortThreads,
    toThreadObject,
    toThreadObjectFull,
} from "./pr-review-threads/helpers";
import type {
    Envelope,
    PrDetailFile,
    PrFileHeader,
    PrReviewThreadsArgs,
    ThreadDetailFile,
    ThreadFileHeader,
    ThreadObject,
} from "./pr-review-threads/types";

type PrReviewThreadsDeps = ShellDep & EnvDep & StdioDep & TmpDep & FileWriterDep & FileSysDep;

const DEFAULT_SCAN_CEILING = 1000;
const DEFAULT_MAX_UNRESOLVED = 50;

export class PrReviewThreadsScript extends ScriptBase<PrReviewThreadsDeps, PrReviewThreadsArgs> {
    /** Set to true once any error envelope has been written to stdout. */
    private envelopeEmitted = false;

    protected argDefinitions(): Parameters<typeof parseArgs>[0] {
        return {
            allowPositionals: true,
            strict: true,
            options: {
                "include-resolved": { type: "boolean" as const },
                "max-unresolved": { type: "string" as const },
            },
        };
    }

    protected validateArgs(parsed: ReturnType<typeof parseArgs>): PrReviewThreadsArgs {
        const mode = parsed.positionals[0];
        if (!mode) {
            this.emitKeylessError(
                "mode is required: pr <pr-number> [--include-resolved] [--max-unresolved <n>]  or  thread <thread-id>",
            );
            throw new ScriptArgsError(
                "mode is required: pr <pr-number> [--include-resolved] [--max-unresolved <n>]  or  thread <thread-id>",
            );
        }

        if (mode === "pr") {
            const prArg = parsed.positionals[1];
            if (!prArg) {
                this.emitKeylessError("pr mode requires a PR number as the second argument");
                throw new ScriptArgsError("pr mode requires a PR number as the second argument");
            }
            const prNumber = Number(prArg);
            if (!Number.isInteger(prNumber) || prNumber <= 0) {
                this.emitKeylessError(`invalid PR number '${prArg}': must be a positive integer`);
                throw new ScriptArgsError(`invalid PR number '${prArg}': must be a positive integer`);
            }

            const maxUnresolvedArg = parsed.values["max-unresolved"] as string | undefined;
            let maxUnresolved = DEFAULT_MAX_UNRESOLVED;
            if (maxUnresolvedArg !== undefined) {
                maxUnresolved = Number(maxUnresolvedArg);
                if (!Number.isInteger(maxUnresolved) || maxUnresolved <= 0) {
                    this.emitKeylessError(`invalid --max-unresolved '${maxUnresolvedArg}': must be a positive integer`);
                    throw new ScriptArgsError(`invalid --max-unresolved '${maxUnresolvedArg}': must be a positive integer`);
                }
            }

            return {
                mode: "pr",
                prNumber,
                includeResolved: (parsed.values["include-resolved"] as boolean | undefined) ?? false,
                maxUnresolved,
            };
        }

        if (mode === "thread") {
            if (parsed.values["include-resolved"] !== undefined) {
                this.emitKeylessError("--include-resolved is not valid for 'thread'");
                throw new ScriptArgsError("--include-resolved is not valid for 'thread'");
            }
            if (parsed.values["max-unresolved"] !== undefined) {
                this.emitKeylessError("--max-unresolved is not valid for 'thread'");
                throw new ScriptArgsError("--max-unresolved is not valid for 'thread'");
            }

            const threadId = parsed.positionals[1];
            if (!threadId) {
                this.emitKeylessError("thread mode requires a thread id as the second argument");
                throw new ScriptArgsError("thread mode requires a thread id as the second argument");
            }
            return { mode: "thread", threadId };
        }

        this.emitKeylessError(`unknown mode '${mode}': expected 'pr' or 'thread'`);
        throw new ScriptArgsError(`unknown mode '${mode}': expected 'pr' or 'thread'`);
    }

    protected async execute(args: PrReviewThreadsArgs): Promise<void> {
        if (args.mode === "pr") {
            await this.runPr(args);
        } else {
            await this.runThread(args);
        }
    }

    // --- Env helpers ---

    private readCeiling(): number {
        const raw = this.deps.env.get("ADDA_DEV_PR_REVIEW_SCAN_CEILING");
        if (raw === undefined) return DEFAULT_SCAN_CEILING;
        const n = Number(raw);
        if (!Number.isInteger(n) || n <= 0)
            throw new ConfigError(`ADDA_DEV_PR_REVIEW_SCAN_CEILING must be a positive integer, got '${raw}'`);
        return n;
    }

    private requireOwnerRepo(): { owner: string; repo: string } {
        const owner = this.deps.env.get("GITHUB_OWNER");
        if (!owner) throw new ScriptError("required environment variable 'GITHUB_OWNER' is not set");
        const repo = this.deps.env.get("GITHUB_REPO");
        if (!repo) throw new ScriptError("required environment variable 'GITHUB_REPO' is not set");
        return { owner, repo };
    }

    // --- GraphQL fetch helpers ---

    private async graphql(variables: Record<string, string | number | null>, query: string): Promise<unknown> {
        const args = ["gh", "api", "graphql", "-f", `query=${query}`];
        for (const [k, v] of Object.entries(variables)) {
            if (v === null) continue;
            args.push("-F", `${k}=${String(v)}`);
        }
        const result = await this.deps.shell.run(args, { strict: false });
        if (result.exitCode !== 0) {
            throw new ScriptError(`GraphQL API call failed: ${result.stderr.trim() || result.stdout.trim()}`);
        }
        return parseJson(result.stdout);
    }

    // --- pr mode ---

    private async runPr(args: Extract<PrReviewThreadsArgs, { mode: "pr" }>): Promise<void> {
        try {
            await this.runPrInner(args);
        } catch (err) {
            if (!this.envelopeEmitted) {
                const message = err instanceof Error ? err.message : String(err);
                this.emitModeError("pr", classifyError(err), message);
            }
            throw err;
        }
    }

    private async runPrInner(args: Extract<PrReviewThreadsArgs, { mode: "pr" }>): Promise<void> {
        const ceiling = this.readCeiling();
        const { owner, repo } = this.requireOwnerRepo();

        // Fetch first page to check totalCount
        const firstRaw = await this.graphql({ owner, repo, number: args.prNumber, after: null }, PR_THREADS_QUERY);
        const firstParsed = PrThreadsPageSchema.safeParse(firstRaw);
        if (!firstParsed.success)
            throw new ScriptZodValidationError("unexpected PR threads response", firstParsed.error, firstRaw);

        if (firstParsed.data.data.repository === null) {
            this.emitModeError("pr", "repo_not_found", `repository ${owner}/${repo} not found`);
            throw new ScriptError(`repository ${owner}/${repo} not found`);
        }
        if (firstParsed.data.data.repository.pullRequest === null) {
            this.emitModeError("pr", "pr_not_found", `PR #${args.prNumber} not found in ${owner}/${repo}`);
            throw new ScriptError(`PR #${args.prNumber} not found in ${owner}/${repo}`);
        }

        const firstPage = firstParsed.data.data.repository.pullRequest.reviewThreads;
        const total = firstPage.totalCount;

        if (total > ceiling) {
            this.emitScanLimitExceeded("pr", total, undefined, ceiling);
            throw new ScriptError(`scan limit exceeded: ${total} threads > ceiling ${ceiling}`, 1);
        }

        // Collect all threads
        const allNodes: ThreadNode[] = [...firstPage.nodes];
        let pageInfo = firstPage.pageInfo;

        while (pageInfo.hasNextPage && pageInfo.endCursor) {
            const pageRaw = await this.graphql(
                { owner, repo, number: args.prNumber, after: pageInfo.endCursor },
                PR_THREADS_QUERY,
            );
            const pageParsed = PrThreadsPageSchema.safeParse(pageRaw);
            if (!pageParsed.success)
                throw new ScriptZodValidationError("unexpected PR threads response page", pageParsed.error, pageRaw);

            const page = pageParsed.data.data.repository?.pullRequest?.reviewThreads;
            if (!page) throw new ScriptError("unexpected null page during pagination");
            allNodes.push(...page.nodes);
            pageInfo = page.pageInfo;
        }

        // Classify
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
            this.deps.stdio.stderr.write(
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

        const resultsFile = await this.writeDetailFile<PrDetailFile>(`${FILE_PREFIX_PR}-${args.prNumber}`, {
            pr: header,
            threads,
            hunks,
        });

        this.emitSuccess({ status: "success", error: "", pr: { ...header, resultsFile } });
    }

    // --- thread mode ---

    private async runThread(args: Extract<PrReviewThreadsArgs, { mode: "thread" }>): Promise<void> {
        try {
            await this.runThreadInner(args);
        } catch (err) {
            if (!this.envelopeEmitted) {
                const message = err instanceof Error ? err.message : String(err);
                this.emitModeError("thread", classifyError(err), message);
            }
            throw err;
        }
    }

    private async runThreadInner(args: Extract<PrReviewThreadsArgs, { mode: "thread" }>): Promise<void> {
        const ceiling = this.readCeiling();

        // Fetch first page
        const firstRaw = await this.graphql({ id: args.threadId, after: null }, THREAD_NODE_QUERY);
        const firstParsed = ThreadNodeQuerySchema.safeParse(firstRaw);
        if (!firstParsed.success)
            throw new ScriptZodValidationError("unexpected thread node response", firstParsed.error, firstRaw);

        const node = firstParsed.data.data.node;
        if (node === null) {
            this.emitModeError("thread", "thread_not_found", `thread '${args.threadId}' not found`);
            throw new ScriptError(`thread '${args.threadId}' not found`);
        }
        if (node.__typename !== "PullRequestReviewThread") {
            this.emitModeError(
                "thread",
                "not_a_thread",
                `node '${args.threadId}' is not a PullRequestReviewThread (got ${node.__typename})`,
            );
            throw new ScriptError(`node '${args.threadId}' is not a PullRequestReviewThread`);
        }

        // node is typed as a general shape; we've validated __typename; access PR-specific fields
        const comments = node.comments;
        if (!comments) throw new ScriptError("unexpected missing comments on PullRequestReviewThread node");
        const pullRequest = node.pullRequest;
        if (!pullRequest) throw new ScriptError("unexpected missing pullRequest on PullRequestReviewThread node");

        const commentCount = comments.totalCount;
        if (commentCount > ceiling) {
            this.emitScanLimitExceeded("thread", undefined, commentCount, ceiling);
            throw new ScriptError(`scan limit exceeded: ${commentCount} comments > ceiling ${ceiling}`, 1);
        }

        // Validate required fields exist
        if (
            node.path === undefined ||
            node.isResolved === undefined ||
            node.isOutdated === undefined ||
            node.diffSide === undefined
        )
            throw new ScriptError("unexpected missing fields on PullRequestReviewThread node");

        // Collect all comments
        const allComments: CommentNode[] = [...comments.nodes];
        let pageInfo = comments.pageInfo;

        while (pageInfo.hasNextPage && pageInfo.endCursor) {
            const pageRaw = await this.graphql({ id: args.threadId, after: pageInfo.endCursor }, THREAD_NODE_QUERY);
            const pageParsed = ThreadNodeQuerySchema.safeParse(pageRaw);
            if (!pageParsed.success)
                throw new ScriptZodValidationError("unexpected thread comments page", pageParsed.error, pageRaw);

            const pageNode = pageParsed.data.data.node;
            const pageComments = pageNode?.comments;
            if (!pageComments) throw new ScriptError("unexpected null comments during pagination");
            allComments.push(...pageComments.nodes);
            pageInfo = pageComments.pageInfo;
        }

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

        const resultsFile = await this.writeDetailFile<ThreadDetailFile>(FILE_PREFIX_THREAD, {
            thread: header,
            threads: [threadObj],
            hunks,
        });

        this.emitSuccess({ status: "success", error: "", thread: { ...header, resultsFile } });
    }

    // --- Atomic file write ---

    private async writeDetailFile<T>(prefix: string, content: T): Promise<string> {
        const epoch = Date.now();
        const finalPath = `${this.deps.tmp.tmpDir()}/${prefix}-${epoch}.json`;
        const tmpPath = this.deps.tmp.tempFilePath("pr-review-threads-tmp", ".json");
        await this.deps.fileWriter.writeFile(tmpPath, JSON.stringify(content, null, 2));
        await this.deps.fileSys.renameFile(tmpPath, finalPath);
        return finalPath;
    }

    // --- Envelope helpers ---

    private emitSuccess(envelope: Envelope): void {
        this.deps.stdio.stdout.write(`${JSON.stringify(envelope)}\n`);
    }

    /**
     * Emit a keyless structured error envelope (for pre-dispatch / arg validation errors).
     * Shape: { "status": "error", "error": "<message>" }
     */
    private emitKeylessError(message: string): void {
        const envelope: { status: "error"; error: string } = { status: "error", error: message };
        this.deps.stdio.stdout.write(`${JSON.stringify(envelope)}\n`);
        this.envelopeEmitted = true;
    }

    /**
     * Emit a mode-keyed structured error envelope.
     * Shape for pr:     { "status": "error", "error": "<message>", "pr":     { "reason": "<code>", … } }
     * Shape for thread: { "status": "error", "error": "<message>", "thread": { "reason": "<code>", … } }
     */
    private emitModeError(mode: "pr", reason: string, message: string): void;
    private emitModeError(mode: "thread", reason: string, message: string): void;
    private emitModeError(mode: "pr" | "thread", reason: string, message: string): void {
        let envelope: Envelope;
        if (mode === "pr") {
            envelope = { status: "error", error: message, pr: { reason } };
        } else {
            envelope = { status: "error", error: message, thread: { reason } };
        }
        this.deps.stdio.stdout.write(`${JSON.stringify(envelope)}\n`);
        this.envelopeEmitted = true;
    }

    private emitScanLimitExceeded(
        mode: "pr" | "thread",
        total: number | undefined,
        commentCount: number | undefined,
        ceiling: number,
    ): void {
        const reason = "scan_limit_exceeded";
        let envelope: Envelope;
        if (mode === "pr") {
            const message = `scan limit exceeded: ${total} threads > ceiling ${ceiling}`;
            envelope = { status: "error", error: message, pr: { reason, total, ceiling } };
        } else {
            const message = `scan limit exceeded: ${commentCount} comments > ceiling ${ceiling}`;
            envelope = { status: "error", error: message, thread: { reason, commentCount, ceiling } };
        }
        this.deps.stdio.stdout.write(`${JSON.stringify(envelope)}\n`);
        this.envelopeEmitted = true;
    }
}

if (import.meta.main) process.exit(await new PrReviewThreadsScript(defaultDeps).run(process.argv));
