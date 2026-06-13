import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import type { FileSysDep, FileWriterDep, TmpDep } from "./capabilities";
import { ScriptError } from "./errors";

export function parseJson(raw: string): unknown {
    try {
        return JSON.parse(raw);
    } catch (e) {
        if (e instanceof SyntaxError) throw new ScriptError(`invalid JSON\nraw data:\n\n${raw}`);
        throw e;
    }
}

export function slugify(title: string): string {
    return title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
}

/**
 * Atomically writes a file using write-then-rename.
 *
 * The pathPattern may contain the following placeholders:
 *   <tmpDir>  — expanded to deps.tmp.tmpDir()
 *   <ts>      — expanded to String(Date.now())
 *   <uuid>    — expanded to a random UUID
 *
 * The temp file is created in the same directory as the resolved final path
 * to guarantee a same-filesystem rename.
 *
 * Returns the resolved final path.
 */
export async function atomicWriteFile(
    deps: TmpDep & FileWriterDep & FileSysDep,
    pathPattern: string,
    content: string,
): Promise<string> {
    const finalPath = pathPattern
        .replace("<tmpDir>", deps.tmp.tmpDir())
        .replace("<ts>", String(Date.now()))
        .replace("<uuid>", randomUUID());

    const dir = dirname(finalPath);
    const tmpPath = `${dir}/.tmp-${randomUUID()}`;

    await deps.fileWriter.writeFile(tmpPath, content);
    await deps.fileSys.renameFile(tmpPath, finalPath);
    return finalPath;
}
