import type { TaskKind } from "../ledger/types";
import type { TokenUsage } from "../models/types";

export interface WorkerTask {
  runId: string;
  taskId: string;
  slug: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  kind: TaskKind;
  model: string;
  worktreePath: string;
  /** Failure report from the previous attempt, appended to the prompt on retry. */
  priorFailure?: string;
  /**
   * Claude Code session id to resume on a verification retry (cheaper than a
   * cold re-run). Only meaningful when the session store persists across runs
   * (the local worker, or a container with a mounted session volume). Unset for
   * the default clean re-run.
   */
  resumeSessionId?: string;
}

export interface WorkerResult {
  ok: boolean;
  sessionId?: string;
  costUsd: number;
  usage?: TokenUsage;
  numTurns?: number;
  summary?: string;
  error?: string;
}

/**
 * The dispatch boundary. A worker runs one task to completion in its worktree.
 * Phase 1 ships a container-isolated worker. This interface is also the seam for
 * distributed discovery: a remote worker keyed by did:aip:{wallet}:{agent_id}
 * would implement the same contract.
 */
export interface WorkerAdapter {
  dispatch(task: WorkerTask, signal: AbortSignal): Promise<WorkerResult>;
}
