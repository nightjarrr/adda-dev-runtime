import type { ShellResult } from "@adda/lib";
import { z } from "zod";

// --- Schemas ---

export const IssueStateSchema = z.object({
    id: z.string(),
    title: z.string(),
    type: z.string(),
    phase: z.string(),
    state: z.enum(["OPEN", "CLOSED"]),
    pr: z.string(),
});

export const GhIssueSchema = z.object({
    title: z.string(),
    labels: z.array(z.object({ name: z.string() })),
    state: z.enum(["OPEN", "CLOSED"]),
});

// --- Types ---

export type IssueState = z.infer<typeof IssueStateSchema>;

export interface IssueStateView {
    id: string;
    title: string;
    type: string;
    phase: string;
    state: string;
    pr: string;
}

export const EMPTY_ISSUE_VIEW: IssueStateView = {
    id: "",
    title: "",
    type: "",
    phase: "",
    state: "",
    pr: "",
};

export interface SuccessEnvelope {
    status: "success";
    issue: IssueStateView;
    details: Record<string, string>;
    error: "";
}

export interface ErrorEnvelope {
    status: "error";
    issue: null;
    details: Record<string, never>;
    error: string;
}

export type Envelope = SuccessEnvelope | ErrorEnvelope;

// --- Interfaces ---

export interface IssueStateStore {
    readState(): Promise<IssueState | null>;
    writeState(state: IssueState): Promise<void>;
    deleteState(): Promise<void>;
    stateFileExists(): Promise<boolean>;
}

export interface ScriptOutput {
    emit(envelope: Envelope): void;
    fail(message: string): never;
    forwardStderr(result: ShellResult): void;
}
