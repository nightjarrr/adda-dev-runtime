import { describe, expect, test } from "bun:test";
import { ScriptError } from "./errors";
import { RawIssueSchema, buildIssueHeader, requireOwnerRepo } from "./github";

// --- buildIssueHeader ---

describe("buildIssueHeader", () => {
    function makeRaw(
        overrides: Partial<{ number: number; title: string; state: string; labels: Array<{ name: string }>; parent?: number }> = {},
    ): { number: number; title: string; state: string; labels: Array<{ name: string }>; parent?: number } {
        return {
            number: 42,
            title: "Test Issue",
            state: "open",
            labels: [{ name: "feature" }, { name: "phase: impl-plan" }],
            ...overrides,
        };
    }

    test("maps number, title, state from raw input", () => {
        const header = buildIssueHeader(makeRaw());
        expect(header.number).toBe(42);
        expect(header.title).toBe("Test Issue");
        expect(header.state).toBe("open");
    });

    test("extracts type label from labels bag", () => {
        const header = buildIssueHeader(makeRaw({ labels: [{ name: "bug" }, { name: "phase: triage" }] }));
        expect(header.type).toBe("bug");
    });

    test("extracts phase label from labels bag", () => {
        const header = buildIssueHeader(makeRaw({ labels: [{ name: "chore" }, { name: "phase: impl-coding" }] }));
        expect(header.phase).toBe("phase: impl-coding");
    });

    test("type is null when no type label present", () => {
        const header = buildIssueHeader(makeRaw({ labels: [{ name: "phase: triage" }] }));
        expect(header.type).toBeNull();
    });

    test("phase is null when no phase label present", () => {
        const header = buildIssueHeader(makeRaw({ labels: [{ name: "feature" }] }));
        expect(header.phase).toBeNull();
    });

    test("labels bag contains all label names verbatim", () => {
        const header = buildIssueHeader(makeRaw({ labels: [{ name: "bug" }, { name: "phase: review" }, { name: "urgent" }] }));
        expect(header.labels).toEqual(["bug", "phase: review", "urgent"]);
    });

    test("state 'open' stays 'open'", () => {
        expect(buildIssueHeader(makeRaw({ state: "open" })).state).toBe("open");
    });

    test("state 'closed' stays 'closed'", () => {
        expect(buildIssueHeader(makeRaw({ state: "closed" })).state).toBe("closed");
    });

    test("state 'OPEN' normalizes to 'open'", () => {
        expect(buildIssueHeader(makeRaw({ state: "OPEN" })).state).toBe("open");
    });

    test("state 'CLOSED' normalizes to 'closed'", () => {
        expect(buildIssueHeader(makeRaw({ state: "CLOSED" })).state).toBe("closed");
    });

    test("unknown state defaults to 'open'", () => {
        expect(buildIssueHeader(makeRaw({ state: "merged" })).state).toBe("open");
    });

    test("sets parent when parent field is provided", () => {
        const header = buildIssueHeader(makeRaw({ parent: 99 }));
        expect(header.parent).toBe(99);
    });

    test("parent is null when parent field is omitted", () => {
        const header = buildIssueHeader(makeRaw());
        expect(header.parent).toBeNull();
    });

    test("parent is null when parent field is undefined", () => {
        const header = buildIssueHeader(makeRaw({ parent: undefined }));
        expect(header.parent).toBeNull();
    });

    test("returns first type label in encounter order", () => {
        const header = buildIssueHeader(makeRaw({ labels: [{ name: "docs" }, { name: "bug" }] }));
        expect(header.type).toBe("docs");
    });
});

// --- requireOwnerRepo ---

describe("requireOwnerRepo", () => {
    test("both env vars set — returns owner and repo", () => {
        const deps = {
            env: { get: (name: string) => ({ GITHUB_OWNER: "myorg", GITHUB_REPO: "myrepo" })[name] },
        };
        const result = requireOwnerRepo(deps);
        expect(result).toEqual({ owner: "myorg", repo: "myrepo" });
    });

    test("missing GITHUB_OWNER — throws ScriptError with missing_env", () => {
        const deps = { env: { get: (name: string) => ({ GITHUB_REPO: "repo" })[name] } };
        expect(() => requireOwnerRepo(deps)).toThrow(ScriptError);
        expect(() => requireOwnerRepo(deps)).toThrow("GITHUB_OWNER");
    });

    test("missing GITHUB_REPO — throws ScriptError with missing_env", () => {
        const deps = { env: { get: (name: string) => ({ GITHUB_OWNER: "owner" })[name] } };
        expect(() => requireOwnerRepo(deps)).toThrow(ScriptError);
        expect(() => requireOwnerRepo(deps)).toThrow("GITHUB_REPO");
    });

    test("missing GITHUB_OWNER — ScriptError reason is missing_env", () => {
        const deps = { env: { get: () => undefined } };
        let caught: unknown;
        try {
            requireOwnerRepo(deps);
        } catch (e) {
            caught = e;
        }
        expect(caught).toBeInstanceOf(ScriptError);
        expect((caught as ScriptError).reason).toBe("missing_env");
    });
});

// --- RawIssueSchema ---

describe("RawIssueSchema", () => {
    test("valid input passes", () => {
        const result = RawIssueSchema.safeParse({
            number: 1,
            title: "Test",
            state: "open",
            labels: [{ name: "bug" }],
        });
        expect(result.success).toBe(true);
    });

    test("invalid state fails", () => {
        const result = RawIssueSchema.safeParse({
            number: 1,
            title: "Test",
            state: "OPEN",
            labels: [],
        });
        expect(result.success).toBe(false);
    });

    test("missing number fails", () => {
        const result = RawIssueSchema.safeParse({
            title: "Test",
            state: "open",
            labels: [],
        });
        expect(result.success).toBe(false);
    });

    test("missing labels fails", () => {
        const result = RawIssueSchema.safeParse({
            number: 1,
            title: "Test",
            state: "open",
        });
        expect(result.success).toBe(false);
    });
});
