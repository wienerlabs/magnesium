import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { WorkerAdapter, WorkerResult, WorkerTask } from "../../src/workers/worker";

export interface StubWorkerOptions {
  /** Fail the first N attempts of every task, then succeed. */
  failTimes?: number;
  content?: string;
}

/**
 * Worker stub that simulates a real worker by writing a deterministic file into
 * the task worktree. Records dispatch order and per-task attempt counts so tests
 * can assert clean re-runs.
 */
export class StubWorker implements WorkerAdapter {
  public readonly dispatched: string[] = [];
  private readonly attempts = new Map<string, number>();

  constructor(private readonly opts: StubWorkerOptions = {}) {}

  async dispatch(task: WorkerTask): Promise<WorkerResult> {
    this.dispatched.push(task.taskId);
    const n = (this.attempts.get(task.taskId) ?? 0) + 1;
    this.attempts.set(task.taskId, n);

    const failTimes = this.opts.failTimes ?? 0;
    if (n <= failTimes) {
      return { ok: false, costUsd: 0.01, error: `stub forced failure (attempt ${n})` };
    }

    await writeFile(
      join(task.worktreePath, `${task.slug}.txt`),
      this.opts.content ?? `clean ${task.slug}`,
      "utf8",
    );
    return {
      ok: true,
      costUsd: 0.01,
      summary: `wrote ${task.slug}.txt`,
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 },
    };
  }
}
