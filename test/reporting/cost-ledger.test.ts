import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config/load";
import { SqliteLedger } from "../../src/ledger/sqlite/sqlite-ledger";
import { costReport } from "../../src/reporting/cost-report";

let dir: string;
let ledger: SqliteLedger;
const config = loadConfig();

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mg-cost-"));
  ledger = new SqliteLedger(join(dir, "ledger.db"));
});

afterEach(async () => {
  ledger.close();
  await rm(dir, { recursive: true, force: true });
});

describe("listLlmCalls + costReport over the ledger", () => {
  it("aggregates recorded llm calls per purpose and per model", () => {
    const run = ledger.createRun({
      goal: "g",
      workspaceDir: "/tmp/ws",
      budgetUsdCap: 5,
      modelOrchestrator: "claude-opus-4-8",
      modelRouter: "claude-haiku-4-5",
    });
    ledger.recordLlmCall({
      runId: run.id,
      purpose: "decompose",
      model: "claude-opus-4-8",
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 0.3,
    });
    ledger.recordLlmCall({
      runId: run.id,
      purpose: "critic",
      model: "claude-haiku-4-5",
      inputTokens: 20,
      outputTokens: 10,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 0.02,
    });

    const calls = ledger.listLlmCalls(run.id);
    expect(calls).toHaveLength(2);

    const summary = costReport(calls, config.pricing);
    expect(summary.totalCalls).toBe(2);
    expect(summary.totalCostUsd).toBeCloseTo(0.32);
    expect(summary.byPurpose.map((l) => l.purpose).sort()).toEqual(["critic", "decompose"]);
    expect(summary.byModel.length).toBe(2);
  });
});
