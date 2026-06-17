import { describe, expect, it } from "vitest";

import type { MagnesiumConfig } from "../../src/config/schema";
import { loadConfig } from "../../src/config/load";
import {
  applyComplexityBudgets,
  budgetForTier,
  estimateComplexity,
  type ComplexityInput,
} from "../../src/orchestrator/complexity";

const config = loadConfig();

/** Build a ComplexityInput with sensible defaults that any field can override. */
function task(partial: Partial<ComplexityInput> = {}): ComplexityInput {
  return {
    description: "do the thing",
    acceptanceCriteria: ["it works"],
    kind: "code",
    ...partial,
  };
}

/** A config clone with the worker block overridden, to prove config-relative scaling. */
function configWith(worker: Partial<MagnesiumConfig["worker"]>): MagnesiumConfig {
  return { ...config, worker: { ...config.worker, ...worker } };
}

describe("estimateComplexity", () => {
  it("classifies a low-complexity task (few criteria, short description, code) as low", () => {
    const tier = estimateComplexity(
      task({ acceptanceCriteria: ["compiles"], description: "short", kind: "code" }),
    );
    expect(tier).toBe("low");
  });

  it("classifies a low-complexity task with two criteria as low", () => {
    const tier = estimateComplexity(
      task({ acceptanceCriteria: ["a", "b"], description: "short", kind: "generic" }),
    );
    expect(tier).toBe("low");
  });

  it("classifies a medium-complexity task (3-4 criteria, generic) as medium", () => {
    expect(
      estimateComplexity(task({ acceptanceCriteria: ["a", "b", "c"], kind: "generic" })),
    ).toBe("medium");
    expect(
      estimateComplexity(task({ acceptanceCriteria: ["a", "b", "c", "d"], kind: "generic" })),
    ).toBe("medium");
  });

  it("classifies a high-complexity task (5+ criteria) as high", () => {
    const tier = estimateComplexity(
      task({ acceptanceCriteria: ["a", "b", "c", "d", "e"], kind: "code" }),
    );
    expect(tier).toBe("high");
  });

  it("boosts a research task by one band unless already high", () => {
    // low -> medium
    expect(estimateComplexity(task({ acceptanceCriteria: ["one"], kind: "research" }))).toBe(
      "medium",
    );
    // medium -> high
    expect(
      estimateComplexity(task({ acceptanceCriteria: ["a", "b", "c"], kind: "research" })),
    ).toBe("high");
    // already high stays high (no bump past the ceiling)
    expect(
      estimateComplexity(
        task({ acceptanceCriteria: ["a", "b", "c", "d", "e"], kind: "research" }),
      ),
    ).toBe("high");
  });

  it("adds to the criteria-based score when the description exceeds 500 chars", () => {
    const longDescription = "x".repeat(501);
    // 2 criteria alone is low; the long description pushes the score to 3 -> medium.
    const short = estimateComplexity(
      task({ acceptanceCriteria: ["a", "b"], description: "short", kind: "generic" }),
    );
    const long = estimateComplexity(
      task({ acceptanceCriteria: ["a", "b"], description: longDescription, kind: "generic" }),
    );
    expect(short).toBe("low");
    expect(long).toBe("medium");
  });

  it("does not mutate its input", () => {
    const input = task({ acceptanceCriteria: ["a", "b", "c"], kind: "research" });
    const snapshot = JSON.parse(JSON.stringify(input));
    estimateComplexity(input);
    expect(input).toEqual(snapshot);
  });
});

describe("budgetForTier", () => {
  it("returns maxAttempts=2 and a halved toolBudget for low (default config)", () => {
    const budget = budgetForTier("low", config);
    expect(budget.tier).toBe("low");
    expect(budget.maxAttempts).toBe(2);
    // ceil(11 / 2) = 6 with the default 11-tool allowlist
    expect(budget.toolBudget).toBe(Math.max(1, Math.ceil(config.worker.allowedTools.length / 2)));
  });

  it("returns maxAttempts of at least 3 and the full tool allowlist for medium", () => {
    const budget = budgetForTier("medium", config);
    expect(budget.tier).toBe("medium");
    expect(budget.maxAttempts).toBeGreaterThanOrEqual(3);
    expect(budget.maxAttempts).toBeLessThanOrEqual(4);
    expect(budget.toolBudget).toBe(config.worker.allowedTools.length);
  });

  it("returns maxAttempts=5 and a doubled toolBudget for high (default config)", () => {
    const budget = budgetForTier("high", config);
    expect(budget.tier).toBe("high");
    expect(budget.maxAttempts).toBe(5);
    expect(budget.toolBudget).toBe(config.worker.allowedTools.length * 2);
  });

  it("anchors medium maxAttempts on config.worker.maxAttempts", () => {
    const budget = budgetForTier("medium", configWith({ maxAttempts: 4 }));
    // medium = max(3, baseAttempts) so a higher configured base raises the floor.
    expect(budget.maxAttempts).toBe(4);
  });

  it("keeps high at least 5 even when the configured base is small", () => {
    expect(budgetForTier("high", configWith({ maxAttempts: 1 })).maxAttempts).toBe(5);
  });

  it("never drops toolBudget below 1 even with a tiny allowlist", () => {
    const tiny = configWith({ allowedTools: ["Read"] });
    expect(budgetForTier("low", tiny).toolBudget).toBeGreaterThanOrEqual(1);
    expect(budgetForTier("medium", tiny).toolBudget).toBeGreaterThanOrEqual(1);
    expect(budgetForTier("high", tiny).toolBudget).toBeGreaterThanOrEqual(1);
  });

  it("scales maxAttempts monotonically low <= medium <= high", () => {
    const low = budgetForTier("low", config).maxAttempts;
    const medium = budgetForTier("medium", config).maxAttempts;
    const high = budgetForTier("high", config).maxAttempts;
    expect(low).toBeLessThanOrEqual(medium);
    expect(medium).toBeLessThanOrEqual(high);
  });
});

describe("applyComplexityBudgets", () => {
  it("hydrates planned tasks with scaled maxAttempts keyed by the estimated tier", () => {
    const planned = [
      {
        description: "short",
        acceptanceCriteria: ["one"],
        kind: "code" as const,
        maxAttempts: 2,
        title: "low one",
      },
      {
        description: "short",
        acceptanceCriteria: ["a", "b", "c", "d", "e"],
        kind: "research" as const,
        maxAttempts: 2,
        title: "high one",
      },
    ];

    const out = applyComplexityBudgets(planned, config);

    expect(out).toHaveLength(2);
    expect(out[0]?.complexityTier).toBe("low");
    expect(out[0]?.maxAttempts).toBe(budgetForTier("low", config).maxAttempts);
    expect(out[0]?.toolBudget).toBe(budgetForTier("low", config).toolBudget);
    // Extra fields on the input are preserved through the spread.
    expect(out[0]?.title).toBe("low one");

    expect(out[1]?.complexityTier).toBe("high");
    expect(out[1]?.maxAttempts).toBe(budgetForTier("high", config).maxAttempts);
    expect(out[1]?.toolBudget).toBe(budgetForTier("high", config).toolBudget);
  });

  it("does not mutate the input tasks", () => {
    const planned = [
      {
        description: "x".repeat(600),
        acceptanceCriteria: ["a", "b", "c", "d", "e"],
        kind: "research" as const,
        maxAttempts: 2,
      },
    ];
    const snapshot = JSON.parse(JSON.stringify(planned));
    applyComplexityBudgets(planned, config);
    expect(planned).toEqual(snapshot);
  });

  it("returns an empty array for no tasks", () => {
    expect(applyComplexityBudgets([], config)).toEqual([]);
  });
});
