// Fetch helpers for pr-review-threads: graphql caller, generic paginate, env helpers.
import type { EnvDep, ShellDep } from "@adda/lib";
import { parseJson, requireOwnerRepo, ScriptZodValidationError } from "@adda/lib";
import type { z } from "zod";
import { PrReviewError } from "./types";

const DEFAULT_SCAN_CEILING = 1000;

// --- GraphQL fetch ---

/**
 * Calls the GitHub GraphQL API with the given query and variables.
 * Throws PrReviewError("api_error") on non-zero exit from gh.
 * The raw stderr is available via err.verboseStderr for upstream diagnostics.
 */
export async function graphql(
    deps: ShellDep,
    variables: Record<string, string | number | null>,
    query: string,
): Promise<unknown> {
    const args = ["gh", "api", "graphql", "-f", `query=${query}`];
    for (const [k, v] of Object.entries(variables)) {
        if (v === null) continue;
        args.push("-F", `${k}=${String(v)}`);
    }
    const result = await deps.shell.run(args);
    return parseJson(result.stdout);
}

// --- Generic cursor paginator ---

/**
 * Continues cursor pagination from where the first page left off.
 *
 * The caller is responsible for fetching the first page and doing any domain
 * checks (null nodes, ceiling guard, etc.) before calling this function.
 *
 * - `firstNodes`: nodes already collected from the first page.
 * - `firstPageInfo`: pageInfo from the first page.
 * - `variables`: base GraphQL variables (without `after`); each page adds `after`.
 * - `query`: GraphQL query string.
 * - `schema`: Zod schema for each page response.
 * - `extractPage(parsed)`: derives nodes + pageInfo from a parsed page; returns null
 *   if the page data is unexpectedly absent (triggers ScriptError).
 * - `validationErrorMessage`: prefix used in ScriptZodValidationError messages.
 *
 * Returns all nodes from all pages (first + subsequent).
 */
export async function paginate<TNode, TSchema extends z.ZodTypeAny>(
    deps: ShellDep,
    firstNodes: TNode[],
    firstPageInfo: { hasNextPage: boolean; endCursor: string | null },
    variables: Record<string, string | number | null>,
    query: string,
    schema: TSchema,
    extractPage: (
        parsed: z.infer<TSchema>,
    ) => { nodes: TNode[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } | null,
    validationErrorMessage: string,
): Promise<TNode[]> {
    const allNodes: TNode[] = [...firstNodes];
    let pageInfo = firstPageInfo;

    while (pageInfo.hasNextPage && pageInfo.endCursor) {
        const pageRaw = await graphql(deps, { ...variables, after: pageInfo.endCursor }, query);
        const pageParsed = schema.safeParse(pageRaw);
        if (!pageParsed.success)
            throw new ScriptZodValidationError(`${validationErrorMessage} page`, pageParsed.error, pageRaw);

        const page = extractPage(pageParsed.data);
        if (!page) throw new PrReviewError("internal_error", "unexpected null page during pagination");
        allNodes.push(...page.nodes);
        pageInfo = page.pageInfo;
    }

    return allNodes;
}

// --- Env helpers ---

export function readCeiling(deps: EnvDep): number {
    const raw = deps.env.get("ADDA_DEV_PR_REVIEW_SCAN_CEILING");
    if (raw === undefined) return DEFAULT_SCAN_CEILING;
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0)
        throw new PrReviewError("invalid_config", `ADDA_DEV_PR_REVIEW_SCAN_CEILING must be a positive integer, got '${raw}'`, {
            exitCode: 2,
        });
    return n;
}

export { requireOwnerRepo };
