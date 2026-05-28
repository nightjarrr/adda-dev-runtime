export type {
    Env,
    EnvDep,
    FileReader,
    FileReaderDep,
    FileWriter,
    FileWriterDep,
    Shell,
    ShellDep,
    ShellResult,
    Sleep,
    SleepDep,
    Stdio,
    StdioDep,
    Tmp,
    TmpDep,
} from "./capabilities";

export { defaultDeps } from "./capabilities";

export { ConfigError, ScriptArgsError, ScriptError } from "./errors";
export { ScriptBase } from "./ScriptBase";
