import { ScriptError } from "./errors";

export function parseJson(raw: string): unknown {
    try {
        return JSON.parse(raw);
    } catch (e) {
        if (e instanceof SyntaxError) throw new ScriptError(`invalid JSON\nraw data:\n\n${raw}`);
        throw e;
    }
}
