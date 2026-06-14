import { describe, expect, it } from "vitest";

import type { PriceRate } from "../../src/config/schema";
import type { LlmCallRow, LlmPurpose } from "../../src/ledger/types";
import {
  costReport,
  formatCostReport,
  type CostReportLine,
} from "../../src/reporting/cost-report";

let nextSeq = 0;

function call(overrides: Partial<LlmCallRow> = {}): LlmCallRow {
  nextSeq += 1;
  return {
    id: `call-${nextSeq}`,
    runId: "run-1",
    taskId: null,
    purpose: "worker" as LlmPurpose,
    model: "claude-sonnet-4-6",
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 10,
    cacheCreationTokens: 5,
    costUsd: 0.01,
    createdAt: "2026-06-14T00:00:00.000Z",
    ...overrides,
  };
}

const pricing: Record<string, PriceRate> = {
  "claude-sonnet-4-6": {
    inputPerMTok: 3,
    outputPerMTok: 15,
    cacheReadPerMTok: 0.3,
    cacheWritePerMTok: 3.75,
  },
  "claude-haiku-4-5": {
    inputPerMTok: 1,
    outputPerMTok: 5,
    cacheReadPerMTok: 0.1,
    cacheWritePerMTok: 1.25,
  },
  default: {
    inputPerMTok: 15,
    outputPerMTok: 75,
    cacheReadPerMTok: 1.5,
    cacheWritePerMTok: 18.75,
  },
};

function lineFor(rows: CostReportLine[], match: (l: CostReportLine) => boolean): CostReportLine {
  const found = rows.find(match);
  expect(found).toBeDefined();
  return found as CostReportLine;
}

describe("costReport", () => {
  it("handles a single purpose, single model, single call", () => {
    const summary = costReport([call({ purpose: "decompose", costUsd: 0.02 })], pricing);
    expect(summary.totalCalls).toBe(1);
    expect(summary.totalCostUsd).toBeCloseTo(0.02);
    expect(summary.byPurpose).toHaveLength(1);
    expect(summary.byModel).toHaveLength(1);
    expect(summary.byPurposeAndModel).toHaveLength(1);
    expect(summary.byPurpose[0]?.purpose).toBe("decompose");
    expect(summary.byPurpose[0]?.callCount).toBe(1);
  });

  it("groups multiple models under the same purpose", () => {
    const summary = costReport(
      [
        call({ purpose: "worker", model: "claude-sonnet-4-6", costUsd: 0.03 }),
        call({ purpose: "worker", model: "claude-haiku-4-5", costUsd: 0.01 }),
      ],
      pricing,
    );
    expect(summary.byPurpose).toHaveLength(1);
    expect(summary.byPurpose[0]?.purpose).toBe("worker");
    expect(summary.byPurpose[0]?.callCount).toBe(2);
    expect(summary.byModel).toHaveLength(2);
    expect(summary.byPurposeAndModel).toHaveLength(2);
  });

  it("groups multiple purposes under the same model", () => {
    const summary = costReport(
      [
        call({ purpose: "route", model: "claude-haiku-4-5" }),
        call({ purpose: "critic", model: "claude-haiku-4-5" }),
      ],
      pricing,
    );
    expect(summary.byModel).toHaveLength(1);
    expect(summary.byModel[0]?.model).toBe("claude-haiku-4-5");
    expect(summary.byModel[0]?.callCount).toBe(2);
    expect(summary.byPurpose).toHaveLength(2);
    expect(summary.byPurposeAndModel).toHaveLength(2);
  });

  it("two-level grouping is correct for mixed purposes and models", () => {
    const summary = costReport(
      [
        call({ purpose: "worker", model: "claude-sonnet-4-6" }),
        call({ purpose: "worker", model: "claude-sonnet-4-6" }),
        call({ purpose: "worker", model: "claude-haiku-4-5" }),
        call({ purpose: "route", model: "claude-haiku-4-5" }),
      ],
      pricing,
    );
    expect(summary.byPurposeAndModel).toHaveLength(3);
    const workerSonnet = lineFor(
      summary.byPurposeAndModel,
      (l) => l.purpose === "worker" && l.model === "claude-sonnet-4-6",
    );
    expect(workerSonnet.callCount).toBe(2);
    const routeHaiku = lineFor(
      summary.byPurposeAndModel,
      (l) => l.purpose === "route" && l.model === "claude-haiku-4-5",
    );
    expect(routeHaiku.callCount).toBe(1);
  });

  it("aggregates totals correctly across all dimensions", () => {
    const calls = [
      call({ inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheCreationTokens: 5, costUsd: 0.01 }),
      call({ inputTokens: 200, outputTokens: 80, cacheReadTokens: 20, cacheCreationTokens: 0, costUsd: 0.02 }),
      call({ inputTokens: 300, outputTokens: 120, cacheReadTokens: 0, cacheCreationTokens: 15, costUsd: 0.03 }),
    ];
    const summary = costReport(calls, pricing);
    expect(summary.totalInputTokens).toBe(600);
    expect(summary.totalOutputTokens).toBe(250);
    expect(summary.totalCacheReadTokens).toBe(30);
    expect(summary.totalCacheCreationTokens).toBe(20);
    expect(summary.totalCostUsd).toBeCloseTo(0.06);
    // byPurpose totals must match run totals because all share one purpose.
    expect(summary.byPurpose[0]?.inputTokens).toBe(600);
    expect(summary.byPurpose[0]?.costUsd).toBeCloseTo(0.06);
  });

  it("sums input, output, and cache tokens within a group", () => {
    const summary = costReport(
      [
        call({ purpose: "compact", inputTokens: 1000, outputTokens: 200, cacheReadTokens: 50, cacheCreationTokens: 25 }),
        call({ purpose: "compact", inputTokens: 500, outputTokens: 100, cacheReadTokens: 25, cacheCreationTokens: 10 }),
      ],
      pricing,
    );
    const line = summary.byPurpose[0];
    expect(line?.inputTokens).toBe(1500);
    expect(line?.outputTokens).toBe(300);
    expect(line?.cacheReadTokens).toBe(75);
    expect(line?.cacheCreationTokens).toBe(35);
  });

  it("returns zero totals for an empty array", () => {
    const summary = costReport([], pricing);
    expect(summary.totalCalls).toBe(0);
    expect(summary.totalCostUsd).toBe(0);
    expect(summary.recomputedCostUsd).toBe(0);
    expect(summary.byPurpose).toEqual([]);
    expect(summary.byModel).toEqual([]);
    expect(summary.byPurposeAndModel).toEqual([]);
  });

  it("byPurpose map groups all calls by purpose string", () => {
    const purposes: LlmPurpose[] = ["decompose", "route", "critic", "compact", "integrate", "worker"];
    const summary = costReport(
      purposes.map((p) => call({ purpose: p })),
      pricing,
    );
    expect(summary.byPurpose).toHaveLength(6);
    const labels = summary.byPurpose.map((l) => l.purpose).sort();
    expect(labels).toEqual([...purposes].sort());
  });

  it("byModel map groups all calls by model string", () => {
    const summary = costReport(
      [
        call({ model: "claude-opus-4-8" }),
        call({ model: "claude-sonnet-4-6" }),
        call({ model: "claude-haiku-4-5" }),
        call({ model: "claude-haiku-4-5" }),
      ],
      pricing,
    );
    expect(summary.byModel).toHaveLength(3);
    const haiku = lineFor(summary.byModel, (l) => l.model === "claude-haiku-4-5");
    expect(haiku.callCount).toBe(2);
  });

  it("recomputes cost from the rate table independently of stored costUsd", () => {
    // 1M input tokens on sonnet at 3 USD/M = 3.00, regardless of stored costUsd.
    const summary = costReport(
      [
        call({
          model: "claude-sonnet-4-6",
          inputTokens: 1_000_000,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          costUsd: 999, // deliberately wrong stored value
        }),
      ],
      pricing,
    );
    expect(summary.recomputedCostUsd).toBeCloseTo(3.0);
    expect(summary.totalCostUsd).toBeCloseTo(999);
  });

  it("formats a report as plain text without throwing", () => {
    const summary = costReport(
      [
        call({ purpose: "worker", model: "claude-sonnet-4-6", costUsd: 0.05 }),
        call({ purpose: "route", model: "claude-haiku-4-5", costUsd: 0.001 }),
      ],
      pricing,
    );
    const text = formatCostReport(summary);
    expect(text).toContain("cost report");
    expect(text).toContain("by purpose");
    expect(text).toContain("by model");
    expect(text).toContain("worker");
    expect(text).not.toContain("—"); // no em dash in rendered output
  });
});
