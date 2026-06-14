import type { TaskKind } from "../ledger/types";
import type { TokenUsage } from "../models/types";

export interface VerifyInput {
  taskId: string;
  kind: TaskKind;
  worktreePath: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  workerSummary?: string;
}

export interface Verdict {
  pass: boolean;
  reason: string;
  report?: string;
  /** Token usage for verdicts produced by a model (critic). Absent for test verifiers. */
  usage?: TokenUsage;
  /** USD cost for model-backed verdicts, so the engine can record an llm_call. */
  costUsd?: number;
}

/** Blocking verification boundary. A task is never integrated before pass. */
export interface Verifier {
  verify(input: VerifyInput): Promise<Verdict>;
}
