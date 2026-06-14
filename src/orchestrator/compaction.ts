import type { RunRow, TaskRow } from "../ledger/types";

export interface TaskDigest {
  id: string;
  slug: string;
  status: string;
  summary: string | null;
}

export interface RunDigest {
  runId: string;
  goal: string;
  status: string;
  completed: TaskDigest[];
  failed: TaskDigest[];
  costUsdSpent: number;
}

/**
 * Compacts a run's completed branches into a small digest. This bounds the
 * orchestrator's context over long runs: instead of re-injecting full task
 * transcripts, later decisions see only this summary. Deterministic for Phase 1;
 * an LLM compaction step can slot in behind the same shape.
 */
export function compactRun(run: RunRow, tasks: TaskRow[]): RunDigest {
  const toDigest = (t: TaskRow): TaskDigest => ({
    id: t.id,
    slug: t.slug,
    status: t.status,
    summary: t.resultSummary,
  });
  return {
    runId: run.id,
    goal: run.goal,
    status: run.status,
    completed: tasks.filter((t) => t.status === "verified" || t.status === "integrated").map(toDigest),
    failed: tasks.filter((t) => t.status === "failed" || t.status === "blocked").map(toDigest),
    costUsdSpent: run.costUsdSpent,
  };
}
