// GraphQL queries and Zod schemas for pr-review-threads.
import { z } from "zod";

// --- GraphQL queries ---

export const PR_THREADS_QUERY = `
query($owner: String!, $repo: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $after) {
        totalCount
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          startLine
          originalLine
          diffSide
          comments(first: 5) {
            totalCount
            pageInfo { hasNextPage }
            nodes {
              author { login }
              body
              url
              createdAt
              diffHunk
            }
          }
        }
      }
    }
  }
}`;

export const THREAD_NODE_QUERY = `
query($id: ID!, $after: String) {
  node(id: $id) {
    __typename
    ... on PullRequestReviewThread {
      isResolved
      isOutdated
      path
      line
      startLine
      originalLine
      diffSide
      pullRequest { number }
      comments(first: 100, after: $after) {
        totalCount
        pageInfo { hasNextPage endCursor }
        nodes {
          author { login }
          body
          url
          createdAt
          diffHunk
        }
      }
    }
  }
}`;

// --- Zod schemas ---

const CommentNodeSchema = z.object({
    author: z.object({ login: z.string() }),
    body: z.string(),
    url: z.string(),
    createdAt: z.string(),
    diffHunk: z.string(),
});

const PageInfoSchema = z.object({
    hasNextPage: z.boolean(),
    endCursor: z.string().nullable(),
});

const ThreadNodeSchema = z.object({
    id: z.string(),
    isResolved: z.boolean(),
    isOutdated: z.boolean(),
    path: z.string(),
    line: z.number().nullable(),
    startLine: z.number().nullable(),
    originalLine: z.number().nullable(),
    diffSide: z.string(),
    comments: z.object({
        totalCount: z.number(),
        pageInfo: z.object({ hasNextPage: z.boolean() }),
        nodes: z.array(CommentNodeSchema),
    }),
});

export const PrThreadsPageSchema = z.object({
    data: z.object({
        repository: z
            .object({
                pullRequest: z
                    .object({
                        reviewThreads: z.object({
                            totalCount: z.number(),
                            pageInfo: PageInfoSchema,
                            nodes: z.array(ThreadNodeSchema),
                        }),
                    })
                    .nullable(),
            })
            .nullable(),
    }),
});

export type PrThreadsPage = z.infer<typeof PrThreadsPageSchema>;
export type ThreadNode = z.infer<typeof ThreadNodeSchema>;
export type CommentNode = z.infer<typeof CommentNodeSchema>;

const ThreadCommentNodeSchema = z.object({
    author: z.object({ login: z.string() }),
    body: z.string(),
    url: z.string(),
    createdAt: z.string(),
    diffHunk: z.string(),
});

export const ThreadNodeQuerySchema = z.object({
    data: z.object({
        node: z
            .object({
                __typename: z.string(),
                isResolved: z.boolean().optional(),
                isOutdated: z.boolean().optional(),
                path: z.string().optional(),
                line: z.number().nullable().optional(),
                startLine: z.number().nullable().optional(),
                originalLine: z.number().nullable().optional(),
                diffSide: z.string().optional(),
                pullRequest: z.object({ number: z.number() }).optional(),
                comments: z
                    .object({
                        totalCount: z.number(),
                        pageInfo: PageInfoSchema,
                        nodes: z.array(ThreadCommentNodeSchema),
                    })
                    .optional(),
            })
            .nullable(),
    }),
});

export type ThreadNodeQueryResult = z.infer<typeof ThreadNodeQuerySchema>;
