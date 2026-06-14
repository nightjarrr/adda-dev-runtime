import { z, type ZodTypeAny } from "zod";

export type ScriptErrorDetail = {
    reason: string;
    message: string;
    details: Record<string, unknown>;
};

export type ScriptEnvelope<T> =
    | { status: "ok"; result: T; error: null }
    | { status: "fail"; result: null; error: ScriptErrorDetail };

const ScriptErrorDetailSchema = z.object({
    reason: z.string(),
    message: z.string(),
    details: z.record(z.string(), z.unknown()),
});

export function makeEnvelopeSchema<T extends ZodTypeAny>(resultSchema: T) {
    return z.discriminatedUnion("status", [
        z.object({ status: z.literal("ok"), result: resultSchema, error: z.null() }),
        z.object({ status: z.literal("fail"), result: z.null(), error: ScriptErrorDetailSchema }),
    ]);
}
