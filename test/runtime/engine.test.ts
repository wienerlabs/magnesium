import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config/load";
import { SqliteLedger } from "../../src/ledger/sqlite/sqlite-ledger";
import { createLogger } from "../../src/logging/logger";
import { MagnesiumEngine } from "../../src/runtime/engine";
import { CodeTestVerifier } from "../../src/verification/code-test-verifier";
import { CompositeVerifier } from "../../src/verification/composite-verifier";
import { CriticVerifier } from "../../src/verification/critic-verifier";
import { LocalWorkerPool } from "../../src/workers/pool";
import { WorkspaceManager } from "../../src/workers/worktree";
import { StubModelClient } from "../fixtures/stub-model";
import { StubWorker } from "../fixtures/stub-worker";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const c = cleanups.pop();
    if (c) await c();
  }
});

async function setup(responses: Record<string, unknown>) {
  const dir = await mkdtemp(join(tmpdir(), "mg-engine-"));
  // A test command that always passes, so the gate hinges on the worker output.
  const config = loadConfig({ verify: { testCommand: "true", testTimeoutMs: 30_000 } });
  const logger = createLogger({ level: "silent" });
  const ledger = new SqliteLedger(join(dir, "ledger.db"));
  const workspace = new WorkspaceManager(join(dir, "worktrees"), logger);
  const stubWorker = new StubWorker();
  const pool = new LocalWorkerPool(stubWorker, config.concurrency, logger);
  const client = new StubModelClient(responses);
  const verifier = new CompositeVerifier(
    new CodeTestVerifier(config.verify.testCommand, config.verify.testTimeoutMs),
    new CriticVerifier(client, config),
  );
  const engine = new MagnesiumEngine({ ledger, client, config, logger, workspace, pool, verifier });
  const workspaceDir = join(dir, "workspace");

  cleanups.push(async () => {
    ledger.close();
    await rm(dir, { recursive: true, force: true });
  });

  return { dir, ledger, config, workspace, stubWorker, engine, workspaceDir };
}

const codeTask = (id: string) => ({
  id,
  title: id,
  description: `implement ${id}`,
  acceptanceCriteria: ["it works"],
  kind: "code" as const,
  dependsOn: [] as string[],
});

describe("MagnesiumEngine", () => {
  it("runs two parallel tasks end to end and integrates results", async () => {
    const ctx = await setup({
      decompose: { tasks: [codeTask("mod-a"), codeTask("mod-b")] },
      integrate: { done: true, reason: "all integrated" },
    });

    const run = ctx.engine.createRun("build two modules", ctx.workspaceDir);
    const final = await ctx.engine.execute(run.id);

    expect(final.status).toBe("completed");
    const tasks = ctx.ledger.listTasks(run.id);
    expect(tasks).toHaveLength(2);
    expect(tasks.every((t) => t.status === "integrated")).toBe(true);
    expect(ctx.stubWorker.dispatched).toHaveLength(2);
    expect(final.integrationBranch).toBeTruthy();
  });

  it("resumes a kill -9 mid-worker by discarding the worktree and re-running clean", async () => {
    const ctx = await setup({ integrate: { done: true, reason: "ok" } });

    // Plan manually so we can craft a post-crash ledger state.
    const run = ctx.engine.createRun("g", ctx.workspaceDir);
    const baseCommit = await ctx.workspace.ensureRepo(ctx.workspaceDir);
    ctx.ledger.setRunBaseCommit(run.id, baseCommit);
    const a = ctx.ledger.createTask({
      runId: run.id,
      slug: "a",
      title: "A",
      description: "write a",
      acceptanceCriteria: ["a exists"],
      kind: "code",
      maxAttempts: 2,
    });
    ctx.ledger.createTask({
      runId: run.id,
      slug: "b",
      title: "B",
      description: "write b",
      acceptanceCriteria: ["b exists"],
      kind: "code",
      maxAttempts: 2,
    });
    ctx.ledger.updateRunStatus(run.id, "running");

    // Simulate task A in flight at kill time, with a dirty partial worktree.
    const wt = await ctx.workspace.createWorktree(ctx.workspaceDir, run.id, a.id, "a", baseCommit);
    await writeFile(join(wt.path, "GARBAGE.txt"), "partial garbage from the killed worker", "utf8");
    ctx.ledger.updateTask(a.id, {
      status: "running",
      worktreePath: wt.path,
      branch: wt.branch,
      attempt: 1,
    });

    const final = await ctx.engine.resume(run.id);

    expect(final.status).toBe("completed");
    const aPath = ctx.workspace.worktreePathFor(run.id, a.id);
    // The partial worktree was discarded; the re-run is clean.
    expect(existsSync(join(aPath, "GARBAGE.txt"))).toBe(false);
    expect(existsSync(join(aPath, "a.txt"))).toBe(true);

    const tasks = ctx.ledger.listTasks(run.id);
    expect(tasks.find((t) => t.id === a.id)?.status).toBe("integrated");
    expect(tasks.every((t) => t.status === "integrated")).toBe(true);

    const events = ctx.ledger.listEvents(run.id);
    expect(events.some((e) => e.type === "resumed_reset" && e.taskId === a.id)).toBe(true);
    expect(ctx.stubWorker.dispatched).toContain(a.id);
  });
});
