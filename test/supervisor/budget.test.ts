import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SqliteLedger } from "../../src/ledger/sqlite/sqlite-ledger";
import { createLogger } from "../../src/logging/logger";
import { BudgetManager } from "../../src/supervisor/budget";

let dir: string;
let ledger: SqliteLedger;
const logger = createLogger({ level: "silent" });

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mg-budget-"));
  ledger = new SqliteLedger(join(dir, "ledger.db"));
});

afterEach(async () => {
  ledger.close();
  await rm(dir, { recursive: true, force: true });
});

function makeRun(cap: number) {
  return ledger.createRun({
    goal: "g",
    workspaceDir: "/tmp/ws",
    budgetUsdCap: cap,
    modelOrchestrator: "o",
    modelRouter: "r",
  });
}

describe("BudgetManager", () => {
  it("allows dispatch within the cap and blocks it past the per-worker reserve", () => {
    const run = makeRun(1.0);
    const budget = new BudgetManager(ledger, run.id, 1.0, 1.0, logger);
    expect(budget.canDispatch()).toBe(true);
    budget.record(0.6);
    // 0.6 + 1.0 per-worker reserve exceeds the 1.0 cap
    expect(budget.canDispatch()).toBe(false);
    expect(budget.isBreached()).toBe(false);
  });

  it("reports a breach once spend reaches the hard cap", () => {
    const run = makeRun(1.0);
    const budget = new BudgetManager(ledger, run.id, 1.0, 0.5, logger);
    expect(budget.record(0.4).breached).toBe(false);
    expect(budget.record(0.7).breached).toBe(true);
    expect(budget.isBreached()).toBe(true);
    expect(budget.spent()).toBeCloseTo(1.1);
    expect(budget.remaining()).toBe(0);
  });
});
