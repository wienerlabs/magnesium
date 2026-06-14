import type { MagnesiumConfig } from "../config/schema";
import type { Logger } from "../logging/logger";
import { execCommand } from "../util/exec";
import {
  buildClaudeArgs,
  mapWorkerResult,
  parseResultEvent,
  type ResultEvent,
} from "./claude-invocation";
import type { WorkerAdapter, WorkerResult, WorkerTask } from "./worker";

/**
 * Documented fallback worker. Runs claude -p directly on the host (no container)
 * with --bare, so it still uses API billing. Used when no container runtime is
 * available. Provides weaker isolation than ContainerWorker (the worktree mount
 * boundary is absent), so it is opt-in via container.enabled = false.
 */
export class LocalProcessWorker implements WorkerAdapter {
  constructor(
    private readonly config: MagnesiumConfig,
    private readonly logger: Logger,
  ) {}

  async dispatch(task: WorkerTask, signal: AbortSignal): Promise<WorkerResult> {
    this.logger.info({ taskId: task.taskId }, "dispatching local worker (no container isolation)");
    const args = buildClaudeArgs(task, this.config, task.worktreePath);

    let resultEvent: ResultEvent | null = null;
    try {
      const res = await execCommand("claude", args, {
        cwd: task.worktreePath,
        timeoutMs: this.config.worker.timeoutMs,
        signal,
        killSignal: "SIGTERM",
        onStdoutLine: (line) => {
          const event = parseResultEvent(line);
          if (event) resultEvent = event;
        },
      });
      return mapWorkerResult(resultEvent, {
        code: res.code,
        stderr: res.stderr,
        timedOut: res.timedOut,
        aborted: res.aborted,
      });
    } catch (err) {
      return {
        ok: false,
        costUsd: 0,
        error: `failed to spawn local worker (is the claude CLI installed?): ${(err as Error).message}`,
      };
    }
  }
}
