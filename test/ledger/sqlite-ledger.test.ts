import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SqliteLedger } from "../../src/ledger/sqlite/sqlite-ledger";

let dir: string;
let ledger: SqliteLedger;
let dbPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mg-ledger-"));
  dbPath = join(dir, "ledger.db");
  ledger = new SqliteLedger(dbPath);
});

afterEach(async () => {
  ledger.close();
  await rm(dir, { recursive: true, force: true });
});

function newRun() {
  return ledger.createRun({
    goal: "g",
    workspaceDir: "/tmp/ws",
    budgetUsdCap: 5,
    modelOrchestrator: "claude-opus-4-8",
    modelRouter: "claude-haiku-4-5",
  });
}

describe("SqliteLedger", () => {
  it("creates and reads a run", () => {
    const run = newRun();
    expect(run.status).toBe("created");
    const fetched = ledger.getRun(run.id);
    expect(fetched?.goal).toBe("g");
    expect(fetched?.costUsdSpent).toBe(0);
  });

  it("creates tasks, dependencies, and reads them back", () => {
    const run = newRun();
    const a = ledger.createTask({
      runId: run.id,
      slug: "a",
      title: "A",
      description: "d",
      acceptanceCriteria: ["x", "y"],
      kind: "code",
      maxAttempts: 2,
    });
    const b = ledger.createTask({
      runId: run.id,
      slug: "b",
      title: "B",
      description: "d",
      acceptanceCriteria: ["z"],
      kind: "generic",
      maxAttempts: 2,
    });
    ledger.addDep(b.id, a.id);
    expect(a.acceptanceCriteria).toEqual(["x", "y"]);
    expect(ledger.listTasks(run.id)).toHaveLength(2);
    expect(ledger.listDeps(run.id)).toEqual([{ taskId: b.id, dependsOnId: a.id }]);
  });

  it("updates tasks with a partial patch", () => {
    const run = newRun();
    const t = ledger.createTask({
      runId: run.id,
      slug: "a",
      title: "A",
      description: "d",
      acceptanceCriteria: ["x"],
      kind: "code",
      maxAttempts: 2,
    });
    const updated = ledger.updateTask(t.id, { status: "verified", attempt: 2, costUsd: 0.5 });
    expect(updated.status).toBe("verified");
    expect(updated.attempt).toBe(2);
    expect(updated.costUsd).toBe(0.5);
  });

  it("assigns monotonic per-run event sequence numbers", () => {
    const run = newRun();
    const e1 = ledger.appendEvent({ runId: run.id, type: "a" });
    const e2 = ledger.appendEvent({ runId: run.id, type: "b" });
    expect(e1.seq).toBe(1);
    expect(e2.seq).toBe(2);
    expect(ledger.listEvents(run.id, 1)).toHaveLength(1);
  });

  it("accumulates run cost atomically", () => {
    const run = newRun();
    expect(ledger.addRunCost(run.id, 0.3)).toBeCloseTo(0.3);
    expect(ledger.addRunCost(run.id, 0.2)).toBeCloseTo(0.5);
    expect(ledger.getRun(run.id)?.costUsdSpent).toBeCloseTo(0.5);
  });

  it("saves and loads the latest checkpoint", () => {
    const run = newRun();
    ledger.saveCheckpoint(run.id, { n: 1 });
    ledger.saveCheckpoint(run.id, { n: 2 });
    expect(ledger.loadLatestCheckpoint(run.id)?.digest).toEqual({ n: 2 });
  });

  it("persists across a reopen (durability proxy for kill -9)", () => {
    const run = newRun();
    ledger.createTask({
      runId: run.id,
      slug: "a",
      title: "A",
      description: "d",
      acceptanceCriteria: ["x"],
      kind: "code",
      maxAttempts: 2,
    });
    ledger.addRunCost(run.id, 1.23);
    ledger.close();

    const reopened = new SqliteLedger(dbPath);
    try {
      expect(reopened.getRun(run.id)?.costUsdSpent).toBeCloseTo(1.23);
      expect(reopened.listTasks(run.id)).toHaveLength(1);
    } finally {
      reopened.close();
    }
  });
});
