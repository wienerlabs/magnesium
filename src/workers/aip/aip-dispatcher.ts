import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { Logger } from "../../logging/logger";
import type { WorkerAdapter, WorkerResult, WorkerTask } from "../worker";
import { DidResolutionError, type WorkerRegistry } from "./worker-registry";

/**
 * Default resolution target. Runs entirely in-process and writes a deterministic
 * file into the task worktree, mirroring the StubWorker pattern so the dispatch
 * seam is exercisable fully offline (no network, no container, no API key).
 *
 * This is what Magnesium falls back to when a task carries no worker DID, or
 * when the registry reports the DID as a soft miss (NOT_FOUND).
 */
export class LoopbackWorker implements WorkerAdapter {
  constructor(private readonly logger?: Logger) {}

  async dispatch(task: WorkerTask, signal: AbortSignal): Promise<WorkerResult> {
    if (signal.aborted) {
      return { ok: false, costUsd: 0, error: "aborted before loopback dispatch" };
    }

    this.logger?.info({ taskId: task.taskId }, "dispatching loopback worker");

    const path = join(task.worktreePath, `${task.slug}.loopback.txt`);
    try {
      await writeFile(path, `loopback ${task.slug}`, "utf8");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        costUsd: 0,
        error: `loopback worker failed to write ${path}: ${msg}`,
      };
    }

    if (signal.aborted) {
      return { ok: false, costUsd: 0, error: "aborted during loopback dispatch" };
    }

    return {
      ok: true,
      costUsd: 0,
      summary: `loopback wrote ${task.slug}.loopback.txt`,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    };
  }
}

export interface AipDispatcherOptions {
  registry: WorkerRegistry;
  /** Fallback used when no DID is provided or the registry returns null. */
  loopback: WorkerAdapter;
  logger?: Logger;
  /** DID of the remote worker to route to. Null routes straight to loopback. */
  workerDid?: string | null;
}

/**
 * Implements the WorkerAdapter contract and routes each task to a worker
 * resolved from the registry by DID. Resolution happens at dispatch time, so the
 * registry can be mutated after construction (hot reload) and the change takes
 * effect on the next dispatch.
 *
 * Fallback policy:
 *  - no DID configured            -> loopback (soft default)
 *  - registry returns null        -> loopback (soft miss / NOT_FOUND)
 *  - registry throws (bad DID,
 *    unsupported scheme)          -> propagated, never silently swallowed
 *
 * Worker results and worker errors are passed through unchanged.
 */
export class AipDispatcher implements WorkerAdapter {
  private readonly registry: WorkerRegistry;
  private readonly loopback: WorkerAdapter;
  private readonly logger?: Logger;
  private readonly workerDid: string | null;

  constructor(opts: AipDispatcherOptions) {
    this.registry = opts.registry;
    this.loopback = opts.loopback;
    this.logger = opts.logger;
    this.workerDid = opts.workerDid ?? null;
  }

  async dispatch(task: WorkerTask, signal: AbortSignal): Promise<WorkerResult> {
    if (this.workerDid === null) {
      return this.loopback.dispatch(task, signal);
    }

    let worker: WorkerAdapter | null;
    try {
      worker = await this.registry.resolve(this.workerDid);
    } catch (err) {
      // INVALID_DID and UNSUPPORTED_SCHEME are hard errors: do not fall back,
      // re-raise so the caller sees a misconfigured DID rather than a silent
      // demotion to loopback.
      if (err instanceof DidResolutionError) {
        this.logger?.error(
          { did: this.workerDid, code: err.code },
          "aip DID resolution failed",
        );
      }
      throw err;
    }

    if (worker === null) {
      this.logger?.warn(
        { did: this.workerDid, taskId: task.taskId },
        "aip DID unresolved (soft miss), using loopback",
      );
      return this.loopback.dispatch(task, signal);
    }

    this.logger?.info(
      { did: this.workerDid, taskId: task.taskId },
      "routing task to resolved remote worker",
    );
    return worker.dispatch(task, signal);
  }
}
