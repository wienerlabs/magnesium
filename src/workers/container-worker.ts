import type { MagnesiumConfig } from "../config/schema";
import type { Logger } from "../logging/logger";
import { execCommand } from "../util/exec";
import { shortId } from "../util/ids";
import {
  buildContainerInvocation,
  mapWorkerResult,
  parseResultEvent,
  type ResultEvent,
} from "./claude-invocation";
import type { WorkerAdapter, WorkerResult, WorkerTask } from "./worker";

/**
 * Runs a headless Claude Code worker inside an isolated container (OrbStack by
 * default). The worktree is the only writable host path; the worker cannot push,
 * force-push, or write outside it.
 */
export class ContainerWorker implements WorkerAdapter {
  constructor(
    private readonly config: MagnesiumConfig,
    private readonly logger: Logger,
  ) {}

  private containerName(task: WorkerTask): string {
    return `mg-${shortId(task.runId)}-${task.slug}-${shortId(task.taskId)}`
      .replace(/[^a-zA-Z0-9_.-]/g, "-")
      .slice(0, 60);
  }

  async dispatch(task: WorkerTask, signal: AbortSignal): Promise<WorkerResult> {
    const name = this.containerName(task);
    const { command, args } = buildContainerInvocation(task, this.config, name);
    this.logger.info({ taskId: task.taskId, container: name }, "dispatching container worker");

    let resultEvent: ResultEvent | null = null;
    try {
      const res = await execCommand(command, args, {
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
        error:
          `failed to spawn container worker (is the ${this.config.container.runtime} ` +
          `daemon running and is image ${this.config.container.image} built?): ` +
          (err as Error).message,
      };
    }
  }
}
