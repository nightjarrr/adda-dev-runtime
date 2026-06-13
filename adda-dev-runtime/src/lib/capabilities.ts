import { rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { ScriptShellError } from "./errors";
import { expandPath } from "./util";

// --- Interfaces ---

export interface ShellResult {
    stdout: string;
    stderr: string;
    exitCode: number;
}

export interface Shell {
    run(command: string[], opts?: { strict?: boolean }): Promise<ShellResult>;
    runSh(command: string, opts?: { strict?: boolean }): Promise<ShellResult>;
}

export interface ShellDep {
    shell: Shell;
}

export interface FileReader {
    readFile(path: string): Promise<string>;
}

export interface FileReaderDep {
    fileReader: FileReader;
}

export interface FileWriter {
    writeFile(pathPattern: string, content: string): Promise<string>;
}

export interface FileWriterDep {
    fileWriter: FileWriter;
}

export interface FileSys {
    deleteFile(path: string): Promise<void>;
    fileExists(path: string): Promise<boolean>;
}

export interface FileSysDep {
    fileSys: FileSys;
}

export interface Stdio {
    stdin: { text(): Promise<string> };
    stdout: { write(data: string): void };
    stderr: { write(data: string): void };
}

export interface StdioDep {
    stdio: Stdio;
}

export interface Env {
    get(name: string): string | undefined;
}

export interface EnvDep {
    env: Env;
}

// --- Bun implementations ---

export class BunShell implements Shell {
    async run(command: string[], opts?: { strict?: boolean }): Promise<ShellResult> {
        const proc = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
        await proc.exited;
        const stdout = await new Response(proc.stdout).text();
        const stderr = await new Response(proc.stderr).text();
        const exitCode = proc.exitCode ?? 1;
        if ((opts?.strict ?? true) && exitCode !== 0) {
            throw new ScriptShellError(command.join(" "), exitCode, stdout, stderr);
        }
        return { stdout, stderr, exitCode };
    }

    async runSh(command: string, opts?: { strict?: boolean }): Promise<ShellResult> {
        return this.run(["sh", "-c", command], opts);
    }
}

export class BunFileReader implements FileReader {
    async readFile(path: string): Promise<string> {
        return Bun.file(path).text();
    }
}

export class BunFileWriter implements FileWriter {
    async writeFile(pathPattern: string, content: string): Promise<string> {
        const finalPath = expandPath(pathPattern);
        const dir = dirname(finalPath);
        const tmpPath = `${dir}/.tmp-${randomUUID()}`;
        await Bun.write(tmpPath, content);
        await rename(tmpPath, finalPath);
        return finalPath;
    }
}

export class BunFileSys implements FileSys {
    async deleteFile(path: string): Promise<void> {
        await unlink(path);
    }

    async fileExists(path: string): Promise<boolean> {
        return Bun.file(path).exists();
    }
}

export class BunStdio implements Stdio {
    readonly stdin = Bun.stdin;
    readonly stdout = process.stdout;
    readonly stderr = process.stderr;
}

export class BunEnv implements Env {
    get(name: string): string | undefined {
        return process.env[name];
    }
}

export interface Sleep {
    sleep(ms: number): Promise<void>;
}

export interface SleepDep {
    sleep: Sleep;
}

export class BunSleep implements Sleep {
    sleep(ms: number): Promise<void> {
        return Bun.sleep(ms);
    }
}

export const defaultDeps: ShellDep & FileReaderDep & FileWriterDep & FileSysDep & StdioDep & EnvDep & SleepDep = {
    shell: new BunShell(),
    fileReader: new BunFileReader(),
    fileWriter: new BunFileWriter(),
    fileSys: new BunFileSys(),
    stdio: new BunStdio(),
    env: new BunEnv(),
    sleep: new BunSleep(),
};
