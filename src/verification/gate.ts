import type { WorkerResult, WorkerTask } from "../workers/worker";
import type { Verdict, VerifyInput } from "./verifier";

export type GatePhase =
  | "worker_started"
  | "worker_failed"
  | "verify_started"
  | "verified"
  | "verify_failed";

export interface GateEvent {
  attempt: number;
  phase: GatePhase;
  detail?: string;
}

export interface GateDeps {
  dispatch: (task: WorkerTask) => Promise<WorkerResult>;
  verify: (input: VerifyInput) => Promise<Verdict>;
  /** Recreates a clean worktree before each attempt (idempotent re-dispatch). */
  prepareWorktree: (attempt: number) => Promise<void>;
  onEvent?: (event: GateEvent) => void;
  /** Checked before each attempt; returning false stops retrying (budget trip). */
  shouldContinue?: () => boolean;
}

export interface GateResult {
  pass: boolean;
  attempts: number;
  costUsd: number;
  lastVerdict?: Verdict;
  lastWorker?: WorkerResult;
  failureReason?: string;
}

/**
 * The blocking verification gate. For each attempt it prepares a clean worktree,
 * dispatches the worker, then verifies. On failure with attempts remaining it
 * re-dispatches with the failure report appended to the worker prompt. Returns
 * pass only when verification succeeds.
 */
export async function runVerificationGate(
  baseTask: WorkerTask,
  maxAttempts: number,
  deps: GateDeps,
): Promise<GateResult> {
  let costUsd = 0;
  let priorFailure: string | undefined;
  let lastWorker: WorkerResult | undefined;
  let lastVerdict: Verdict | undefined;
  let failureReason: string | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (deps.shouldContinue && !deps.shouldContinue()) {
      failureReason = failureReason ?? "stopped before attempt (budget or supervisor)";
      break;
    }
    await deps.prepareWorktree(attempt);

    const task: WorkerTask = priorFailure ? { ...baseTask, priorFailure } : { ...baseTask };
    deps.onEvent?.({ attempt, phase: "worker_started" });
    const worker = await deps.dispatch(task);
    lastWorker = worker;
    costUsd += worker.costUsd;

    if (!worker.ok) {
      failureReason = worker.error ?? "worker failed";
      priorFailure = failureReason;
      deps.onEvent?.({ attempt, phase: "worker_failed", detail: failureReason });
      continue;
    }

    deps.onEvent?.({ attempt, phase: "verify_started" });
    const input: VerifyInput = {
      taskId: baseTask.taskId,
      kind: baseTask.kind,
      worktreePath: baseTask.worktreePath,
      title: baseTask.title,
      description: baseTask.description,
      acceptanceCriteria: baseTask.acceptanceCriteria,
    };
    if (worker.summary !== undefined) input.workerSummary = worker.summary;
    const verdict = await deps.verify(input);
    lastVerdict = verdict;

    if (verdict.pass) {
      deps.onEvent?.({ attempt, phase: "verified", detail: verdict.reason });
      return { pass: true, attempts: attempt, costUsd, lastVerdict: verdict, lastWorker: worker };
    }

    failureReason = verdict.reason;
    priorFailure = `${verdict.reason}\n${verdict.report ?? ""}`.trim();
    deps.onEvent?.({ attempt, phase: "verify_failed", detail: verdict.reason });
  }

  const result: GateResult = { pass: false, attempts: maxAttempts, costUsd };
  if (lastVerdict) result.lastVerdict = lastVerdict;
  if (lastWorker) result.lastWorker = lastWorker;
  if (failureReason) result.failureReason = failureReason;
  return result;
}
