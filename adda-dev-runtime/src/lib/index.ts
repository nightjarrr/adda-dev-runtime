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

export { ConfigError, ScriptArgsError, ScriptError, ScriptZodValidationError } from "./errors";
export type { EmptyArgs } from "./ScriptBase";
export { ScriptBase } from "./ScriptBase";
export { parseJson } from "./util";
