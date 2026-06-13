import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { ScriptError } from "./errors";

export function parseJson(raw: string): unknown {
    try {
        return JSON.parse(raw);
    } catch (e) {
        if (e instanceof SyntaxError) throw new ScriptError(`invalid JSON\nraw data:\n\n${raw}`);
        throw e;
    }
}

export function expandPath(pattern: string): string {
    return pattern.replace("<tmpDir>", tmpdir()).replace("<ts>", String(Date.now())).replace("<uuid>", randomUUID());
}

export function slugify(title: string): string {
    return title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
}
