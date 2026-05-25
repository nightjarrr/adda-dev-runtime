import { createInterface } from "node:readline";
import { $ } from "bun";

// --- Interfaces ---

export interface ShellResult {
    stdout: string;
    exitCode: number;
}

export interface Shell {
    run(command: string[]): Promise<ShellResult>;
}

export interface FileReader {
    readFile(path: string): Promise<string>;
}

export interface FileWriter {
    writeFile(path: string, content: string): Promise<void>;
}

export interface Stdio {
    readLine(): Promise<string>;
    writeOut(text: string): Promise<void>;
    writeErr(text: string): Promise<void>;
}

export interface Env {
    get(name: string): string | undefined;
}

// --- Bun implementations ---

export class BunShell implements Shell {
    static create(): BunShell {
        return new BunShell();
    }

    async run(command: string[]): Promise<ShellResult> {
        const [cmd, ...args] = command;
        const proc = await $`${cmd} ${args}`.nothrow().quiet();
        return {
            stdout: proc.stdout.toString(),
            exitCode: proc.exitCode ?? 1,
        };
    }
}

export class BunFileReader implements FileReader {
    static create(): BunFileReader {
        return new BunFileReader();
    }

    async readFile(path: string): Promise<string> {
        return Bun.file(path).text();
    }
}

export class BunFileWriter implements FileWriter {
    static create(): BunFileWriter {
        return new BunFileWriter();
    }

    async writeFile(path: string, content: string): Promise<void> {
        await Bun.write(path, content);
    }
}

export class BunStdio implements Stdio {
    private readonly input: NodeJS.ReadableStream;

    constructor(input: NodeJS.ReadableStream = process.stdin) {
        this.input = input;
    }

    static create(): BunStdio {
        return new BunStdio();
    }

    async readLine(): Promise<string> {
        const rl = createInterface({ input: this.input, terminal: false });
        for await (const line of rl) {
            rl.close();
            return line;
        }
        return "";
    }

    async writeOut(text: string): Promise<void> {
        await process.stdout.write(text);
    }

    async writeErr(text: string): Promise<void> {
        await process.stderr.write(text);
    }
}

export class BunEnv implements Env {
    static create(): BunEnv {
        return new BunEnv();
    }

    get(name: string): string | undefined {
        return process.env[name];
    }
}
