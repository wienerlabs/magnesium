import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config/load";
import { SqliteLedger } from "../../src/ledger/sqlite/sqlite-ledger";
import { createLogger } from "../../src/logging/logger";
import { MagnesiumEngine } from "../../src/runtime/engine";
import { RunControlRegistry } from "../../src/runtime/run-control";
import { CodeTestVerifier } from "../../src/verification/code-test-verifier";
import { CompositeVerifier } from "../../src/verification/composite-verifier";
import { CriticVerifier } from "../../src/verification/critic-verifier";
import { LocalWorkerPool } from "../../src/workers/pool";
import type { WorkerAdapter, WorkerResult, WorkerTask } from "../../src/workers/worker";
import { WorkspaceManager } from "../../src/workers/worktree";
import { StubModelClient } from "../fixtures/stub-model";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    const c = cleanups.pop();
    if (c) await c();
  }
});

describe("MagnesiumEngine cooperative operator pause", () => {
  it("pauses mid-run when requested, then resumes to completion", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mg-pause-"));
    const config = loadConfig({ concurrency: 1, verify: { testCommand: "true", testTimeoutMs: 30_000 } });
    const logger = createLogger({ level: "silent" });
    const ledger = new SqliteLedger(join(dir, "ledger.db"));
    const workspace = new WorkspaceManager(join(dir, "worktrees"), logger);
    const registry = new RunControlRegistry();
    const client = new StubModelClient({ integrate: { done: true, reason: "ok" } });
    cleanups.push(async () => {
      ledger.close();
      await rm(dir, { recursive: true, force: true });
    });

    let runId = "";
    let dispatches = 0;
    // Worker requests an operator pause on its first dispatch, so after the first
    // task drains the engine pauses before dispatching the second.
    const pauseWorker: WorkerAdapter = {
      async dispatch(task: WorkerTask): Promise<WorkerResult> {
        dispatches += 1;
        if (dispatches === 1 && runId) registry.get(runId).requestPause();
        await writeFile(join(task.worktreePath, `${task.slug}.txt`), "ok", "utf8");
        return { ok: true, costUsd: 0, summary: "done" };
      },
    };

    const pool = new LocalWorkerPool(pauseWorker, config.concurrency, logger);
    const verifier = new CompositeVerifier(
      new CodeTestVerifier(config.verify.testCommand, config.verify.testTimeoutMs),
      new CriticVerifier(client, config),
    );
    const engine = new MagnesiumEngine({
      ledger,
      client,
      config,
      logger,
      workspace,
      pool,
      verifier,
      control: registry,
    });

    const run = engine.createRun("two tasks, pause after the first", join(dir, "workspace"));
    runId = run.id;
    const baseCommit = await workspace.ensureRepo(join(dir, "workspace"));
    ledger.setRunBaseCommit(run.id, baseCommit);
    const a = ledger.createTask({ runId: run.id, slug: "a", title: "A", description: "write a", acceptanceCriteria: ["a"], kind: "code", maxAttempts: 2 });
    const b = ledger.createTask({ runId: run.id, slug: "b", title: "B", description: "write b", acceptanceCriteria: ["b"], kind: "code", maxAttempts: 2 });
    ledger.updateRunStatus(run.id, "running");

    const paused = await engine.execute(run.id);
    expect(paused.status).toBe("paused");
    expect(registry.get(run.id).state()).toBe("paused");
    expect(ledger.listEvents(run.id).map((e) => e.type)).toContain("operator_paused");

    const afterPause = ledger.listTasks(run.id);
    expect(afterPause.find((t) => t.id === a.id)?.status).toBe("verified");
    expect(afterPause.find((t) => t.id === b.id)?.status).toBe("pending");

    // Operator resumes: the run finishes the remaining task and integrates.
    registry.get(run.id).requestResume();
    const done = await engine.resume(run.id);
    expect(done.status).toBe("completed");
    expect(ledger.listTasks(run.id).every((t) => t.status === "integrated")).toBe(true);
  });
});
