// --- Interfaces ---

export interface ShellResult {
    stdout: string;
    stderr: string;
    exitCode: number;
}

export interface Shell {
    run(command: string[]): Promise<ShellResult>;
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
    writeFile(path: string, content: string): Promise<void>;
}

export interface FileWriterDep {
    fileWriter: FileWriter;
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
    async run(command: string[]): Promise<ShellResult> {
        const proc = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
        await proc.exited;
        return {
            stdout: await new Response(proc.stdout).text(),
            stderr: await new Response(proc.stderr).text(),
            exitCode: proc.exitCode ?? 1,
        };
    }
}

export class BunFileReader implements FileReader {
    async readFile(path: string): Promise<string> {
        return Bun.file(path).text();
    }
}

export class BunFileWriter implements FileWriter {
    async writeFile(path: string, content: string): Promise<void> {
        await Bun.write(path, content);
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
