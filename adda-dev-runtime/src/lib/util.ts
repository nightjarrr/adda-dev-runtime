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
 * Atomically writes a detail file to the tmp directory using write-then-rename.
 * Returns the final file path.
 */
export async function writeDetailFile<T>(
    deps: TmpDep & FileWriterDep & FileSysDep,
    prefix: string,
    content: T,
): Promise<string> {
    const epoch = Date.now();
    const finalPath = `${deps.tmp.tmpDir()}/${prefix}-${epoch}.json`;
    const tmpPath = deps.tmp.tempFilePath("pr-review-threads-tmp", ".json");
    await deps.fileWriter.writeFile(tmpPath, JSON.stringify(content, null, 2));
    await deps.fileSys.renameFile(tmpPath, finalPath);
    return finalPath;
}
