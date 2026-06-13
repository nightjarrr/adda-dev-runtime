export type {
    Env,
    EnvDep,
    FileReader,
    FileReaderDep,
    FileSys,
    FileSysDep,
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

export {
    ConfigError,
    ScriptArgsError,
    ScriptError,
    ScriptShellError,
    ScriptStructuredError,
    ScriptZodValidationError,
} from "./errors";
export type { EmptyArgs } from "./ScriptBase";
export { ScriptBase } from "./ScriptBase";
export { parseJson, slugify } from "./util";
