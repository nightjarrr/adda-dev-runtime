import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { makeEnvelopeSchema } from "./envelope";

const ItemSchema = z.object({ id: z.number(), name: z.string() });

describe("makeEnvelopeSchema", () => {
    test("parses a valid ok envelope and exposes result", () => {
        const schema = makeEnvelopeSchema(ItemSchema);
        const input = { status: "ok", result: { id: 1, name: "foo" }, error: null };
        const parsed = schema.safeParse(input);
        expect(parsed.success).toBe(true);
        if (!parsed.success) return;
        expect(parsed.data.status).toBe("ok");
        if (parsed.data.status === "ok") {
            expect(parsed.data.result.id).toBe(1);
            expect(parsed.data.result.name).toBe("foo");
            expect(parsed.data.error).toBeNull();
        }
    });

    test("parses a valid fail envelope and exposes error.reason", () => {
        const schema = makeEnvelopeSchema(ItemSchema);
        const input = { status: "fail", result: null, error: { reason: "not_found", message: "item not found", details: {} } };
        const parsed = schema.safeParse(input);
        expect(parsed.success).toBe(true);
        if (!parsed.success) return;
        expect(parsed.data.status).toBe("fail");
        if (parsed.data.status === "fail") {
            expect(parsed.data.result).toBeNull();
            expect(parsed.data.error.reason).toBe("not_found");
            expect(parsed.data.error.message).toBe("item not found");
        }
    });

    test("rejects an envelope with unknown status", () => {
        const schema = makeEnvelopeSchema(ItemSchema);
        const input = { status: "unknown", result: null, error: null };
        const parsed = schema.safeParse(input);
        expect(parsed.success).toBe(false);
    });

    test("rejects a fail envelope with missing reason", () => {
        const schema = makeEnvelopeSchema(ItemSchema);
        const input = { status: "fail", result: null, error: { message: "oops", details: {} } };
        const parsed = schema.safeParse(input);
        expect(parsed.success).toBe(false);
    });

    test("rejects an ok envelope where result does not match the provided schema", () => {
        const schema = makeEnvelopeSchema(ItemSchema);
        const input = { status: "ok", result: { id: "not-a-number", name: "foo" }, error: null };
        const parsed = schema.safeParse(input);
        expect(parsed.success).toBe(false);
    });
});
