import PQueue from "p-queue";

import type { MagnesiumConfig } from "../config/schema";
import type { Logger } from "../logging/logger";
import { ContainerWorker } from "./container-worker";
import { LocalProcessWorker } from "./local-worker";
import type { WorkerAdapter, WorkerResult, WorkerTask } from "./worker";

export function createWorker(config: MagnesiumConfig, logger: Logger): WorkerAdapter {
  return config.container.enabled
    ? new ContainerWorker(config, logger)
    : new LocalProcessWorker(config, logger);
}

/**
 * Bounded-concurrency dispatcher over a WorkerAdapter. Tracks one AbortController
 * per in-flight task so the supervisor can SIGTERM a single worker or all of them
 * (budget trip). This is the local implementation of the dispatch seam; a
 * distributed registry would slot in behind the same surface.
 */
export class LocalWorkerPool {
  private readonly queue: PQueue;
  private readonly controllers = new Map<string, AbortController>();

  constructor(
    private readonly worker: WorkerAdapter,
    concurrency: number,
    private readonly logger: Logger,
  ) {
    this.queue = new PQueue({ concurrency });
  }

  async dispatch(task: WorkerTask): Promise<WorkerResult> {
    const controller = new AbortController();
    this.controllers.set(task.taskId, controller);
    try {
      const result = await this.queue.add(() => this.worker.dispatch(task, controller.signal));
      return result as WorkerResult;
    } finally {
      this.controllers.delete(task.taskId);
    }
  }

  abortTask(taskId: string): void {
    this.controllers.get(taskId)?.abort();
  }

  /** SIGTERM all in-flight workers and drop anything still queued. */
  abortAll(): void {
    this.logger.warn({ inFlight: this.controllers.size }, "aborting all workers");
    for (const controller of this.controllers.values()) controller.abort();
    this.queue.clear();
  }

  get inFlight(): number {
    return this.controllers.size;
  }
}
