import { mkdtemp, rm } from "node:fs/promises";
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
  const dir = await mkdtemp(join(tmpdir(), "mg-engine2-"));
  const config = loadConfig({ verify: { testCommand: "true", testTimeoutMs: 30_000 } });
  const logger = createLogger({ level: "silent" });
  const ledger = new SqliteLedger(join(dir, "ledger.db"));
  const workspace = new WorkspaceManager(join(dir, "worktrees"), logger);
  const pool = new LocalWorkerPool(new StubWorker(), config.concurrency, logger);
  const client = new StubModelClient(responses);
  const verifier = new CompositeVerifier(
    new CodeTestVerifier(config.verify.testCommand, config.verify.testTimeoutMs),
    new CriticVerifier(client, config),
  );
  const engine = new MagnesiumEngine({ ledger, client, config, logger, workspace, pool, verifier });
  cleanups.push(async () => {
    ledger.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { ledger, engine, workspaceDir: join(dir, "workspace") };
}

describe("MagnesiumEngine Phase 2 wiring", () => {
  it("routes tasks, records critic cost, and records router cost end to end", async () => {
    const ctx = await setup({
      decompose: {
        tasks: [
          { id: "code-a", title: "A", description: "build a", acceptanceCriteria: ["x"], kind: "code", dependsOn: [] },
          { id: "gen-b", title: "B", description: "write b", acceptanceCriteria: ["y"], kind: "generic", dependsOn: [] },
        ],
      },
      route: {
        tasks: [
          { id: "code-a", kind: "code", acceptanceCriteria: ["x"], warnings: [] },
          { id: "gen-b", kind: "generic", acceptanceCriteria: ["y"], warnings: ["double-check scope"] },
        ],
      },
      critic: { pass: true, confidence: 0.9, reasons: ["meets criteria"] },
      integrate: { done: true, reason: "all integrated" },
    });

    const run = ctx.engine.createRun("two tasks, one judged by the critic", ctx.workspaceDir);
    const final = await ctx.engine.execute(run.id);

    expect(final.status).toBe("completed");

    const purposes = new Set(ctx.ledger.listLlmCalls(run.id).map((c) => c.purpose));
    // Router triage and critic-cost wiring both record their own llm_calls.
    expect(purposes.has("decompose")).toBe(true);
    expect(purposes.has("route")).toBe(true);
    expect(purposes.has("critic")).toBe(true);
    expect(purposes.has("integrate")).toBe(true);

    const events = ctx.ledger.listEvents(run.id).map((e) => e.type);
    expect(events).toContain("routed");
  });
});
