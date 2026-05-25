export function greet(): string {
    return "Hello from ADDA dev runtime!";
}

if (import.meta.main) {
    // biome-ignore lint/suspicious/noConsole: intentional output for hello-world script
    console.log(greet());
}
