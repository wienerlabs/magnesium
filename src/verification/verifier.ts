import type { TaskKind } from "../ledger/types";

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
}

/** Blocking verification boundary. A task is never integrated before pass. */
export interface Verifier {
  verify(input: VerifyInput): Promise<Verdict>;
}
