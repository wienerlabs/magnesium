import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadConfig } from "../../../src/config/load";
import { createLogger } from "../../../src/logging/logger";
import type { WorkerAdapter, WorkerResult, WorkerTask } from "../../../src/workers/worker";
import { AipDispatcher, LoopbackWorker } from "../../../src/workers/aip/aip-dispatcher";
import { MemoryWorkerRegistry, type ResolverContext } from "../../../src/workers/aip/worker-registry";

const logger = createLogger({ level: "silent" });
const config = loadConfig();
const ctx: ResolverContext = { logger, config };

const AIP_DID = "did:aip:Wallet99:code-worker";

let worktree: string;

beforeEach(async () => {
  worktree = await mkdtemp(join(tmpdir(), "mg-aip-"));
});

afterEach(async () => {
  await rm(worktree, { recursive: true, force: true });
});

function makeTask(): WorkerTask {
  return {
    runId: "run123456",
    taskId: "task78901234",
    slug: "feature",
    title: "Build feature",
    description: "implement it",
    acceptanceCriteria: ["tests pass"],
    kind: "code",
    model: "claude-sonnet-4-6",
    worktreePath: worktree,
  };
}

/** Records the task it received and returns a canned result. */
class RecordingWorker implements WorkerAdapter {
  public received: WorkerTask | undefined;
  constructor(private readonly result: WorkerResult) {}
  async dispatch(task: WorkerTask, signal: AbortSignal): Promise<WorkerResult> {
    this.received = task;
    if (signal.aborted) return { ok: false, costUsd: 0, error: "aborted" };
    return this.result;
  }
}

describe("AipDispatcher", () => {
  it("routes the task to the remote worker when the DID resolves", async () => {
    const remote = new RecordingWorker({ ok: true, costUsd: 0.5, summary: "remote done" });
    const registry = new MemoryWorkerRegistry(ctx);
    registry.register("aip", () => remote);
    const dispatcher = new AipDispatcher({
      registry,
      loopback: new LoopbackWorker(logger),
      logger,
      workerDid: AIP_DID,
    });

    const result = await dispatcher.dispatch(makeTask(), new AbortController().signal);
    expect(result.summary).toBe("remote done");
    expect(remote.received?.taskId).toBe("task78901234");
  });

  it("falls back to the loopback worker when the registry returns null", async () => {
    const registry = new MemoryWorkerRegistry(ctx);
    registry.register("aip", () => null);
    const dispatcher = new AipDispatcher({
      registry,
      loopback: new LoopbackWorker(logger),
      logger,
      workerDid: AIP_DID,
    });

    const result = await dispatcher.dispatch(makeTask(), new AbortController().signal);
    expect(result.ok).toBe(true);
    expect(result.summary).toContain("loopback");
  });

  it("falls back to the loopback worker when the DID is null", async () => {
    const registry = new MemoryWorkerRegistry(ctx);
    // No resolver registered; if the dispatcher queried the registry it would
    // throw UNSUPPORTED_SCHEME. A null DID must skip resolution entirely.
    const dispatcher = new AipDispatcher({
      registry,
      loopback: new LoopbackWorker(logger),
      logger,
      workerDid: null,
    });

    const result = await dispatcher.dispatch(makeTask(), new AbortController().signal);
    expect(result.ok).toBe(true);
    expect(result.summary).toContain("loopback");
  });

  it("falls back to loopback when workerDid is omitted entirely", async () => {
    const registry = new MemoryWorkerRegistry(ctx);
    const dispatcher = new AipDispatcher({ registry, loopback: new LoopbackWorker(logger) });
    const result = await dispatcher.dispatch(makeTask(), new AbortController().signal);
    expect(result.ok).toBe(true);
    expect(result.summary).toContain("loopback");
  });

  it("propagates the worker result (ok, cost, usage, summary) unchanged", async () => {
    const canned: WorkerResult = {
      ok: true,
      costUsd: 1.23,
      summary: "verbatim",
      sessionId: "sess-9",
      numTurns: 4,
      usage: { inputTokens: 11, outputTokens: 22, cacheReadTokens: 3, cacheCreationTokens: 1 },
    };
    const registry = new MemoryWorkerRegistry(ctx);
    registry.register("aip", () => new RecordingWorker(canned));
    const dispatcher = new AipDispatcher({
      registry,
      loopback: new LoopbackWorker(logger),
      workerDid: AIP_DID,
    });

    const result = await dispatcher.dispatch(makeTask(), new AbortController().signal);
    expect(result).toEqual(canned);
  });

  it("propagates worker errors transparently", async () => {
    const failure: WorkerResult = { ok: false, costUsd: 0.02, error: "remote blew up" };
    const registry = new MemoryWorkerRegistry(ctx);
    registry.register("aip", () => new RecordingWorker(failure));
    const dispatcher = new AipDispatcher({
      registry,
      loopback: new LoopbackWorker(logger),
      workerDid: AIP_DID,
    });

    const result = await dispatcher.dispatch(makeTask(), new AbortController().signal);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("remote blew up");
  });

  it("re-raises DidResolutionError instead of falling back (hard error)", async () => {
    const registry = new MemoryWorkerRegistry(ctx);
    // No aip resolver -> UNSUPPORTED_SCHEME; must propagate, not silently loopback.
    const dispatcher = new AipDispatcher({
      registry,
      loopback: new LoopbackWorker(logger),
      workerDid: "did:web:Wallet99:agent",
    });
    await expect(
      dispatcher.dispatch(makeTask(), new AbortController().signal),
    ).rejects.toMatchObject({ name: "DidResolutionError", code: "UNSUPPORTED_SCHEME" });
  });

  it("queries the registry at dispatch time (hot reload), not at construction", async () => {
    const registry = new MemoryWorkerRegistry(ctx);
    const dispatcher = new AipDispatcher({
      registry,
      loopback: new LoopbackWorker(logger),
      workerDid: AIP_DID,
    });
    // Resolver registered AFTER the dispatcher exists.
    const remote = new RecordingWorker({ ok: true, costUsd: 0, summary: "late bind" });
    registry.register("aip", () => remote);

    const result = await dispatcher.dispatch(makeTask(), new AbortController().signal);
    expect(result.summary).toBe("late bind");
  });
});

describe("LoopbackWorker", () => {
  it("writes a deterministic file to the worktree for offline testing", async () => {
    const worker = new LoopbackWorker(logger);
    const result = await worker.dispatch(makeTask(), new AbortController().signal);
    expect(result.ok).toBe(true);

    const file = join(worktree, "feature.loopback.txt");
    const stats = await stat(file);
    expect(stats.isFile()).toBe(true);
    const contents = await readFile(file, "utf8");
    expect(contents).toBe("loopback feature");
  });

  it("reports cost and usage", async () => {
    const worker = new LoopbackWorker(logger);
    const result = await worker.dispatch(makeTask(), new AbortController().signal);
    expect(result.costUsd).toBe(0);
    expect(result.usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
  });

  it("aborts the loopback worker when the signal is already fired", async () => {
    const controller = new AbortController();
    controller.abort();
    const worker = new LoopbackWorker(logger);
    const result = await worker.dispatch(makeTask(), controller.signal);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("aborted");
    // No file should have been written.
    await expect(stat(join(worktree, "feature.loopback.txt"))).rejects.toThrow();
  });

  it("surfaces a write failure as a non-ok result", async () => {
    const worker = new LoopbackWorker(logger);
    const task = makeTask();
    task.worktreePath = join(worktree, "does", "not", "exist");
    const result = await worker.dispatch(task, new AbortController().signal);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("failed to write");
  });
});

describe("AipDispatcher abort propagation", () => {
  it("aborts the remote worker when the signal is fired", async () => {
    const remote = new RecordingWorker({ ok: true, costUsd: 0, summary: "should not arrive" });
    const registry = new MemoryWorkerRegistry(ctx);
    registry.register("aip", () => remote);
    const dispatcher = new AipDispatcher({
      registry,
      loopback: new LoopbackWorker(logger),
      workerDid: AIP_DID,
    });

    const controller = new AbortController();
    controller.abort();
    const result = await dispatcher.dispatch(makeTask(), controller.signal);
    // RecordingWorker checks signal.aborted and returns an aborted result.
    expect(result.ok).toBe(false);
    expect(result.error).toBe("aborted");
  });

  it("aborts the loopback worker when the signal is fired", async () => {
    const registry = new MemoryWorkerRegistry(ctx);
    const dispatcher = new AipDispatcher({
      registry,
      loopback: new LoopbackWorker(logger),
      workerDid: null,
    });
    const controller = new AbortController();
    controller.abort();
    const result = await dispatcher.dispatch(makeTask(), controller.signal);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("aborted");
  });
});
