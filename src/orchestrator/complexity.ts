import { z } from "zod";

import type { MagnesiumConfig } from "../config/schema";

/**
 * Complexity-scaled routing (Phase 2.5).
 *
 * This module mirrors the Mythos-class harness rule "scale tool calls to
 * complexity (1 fact / 3-5 medium / 5-10 research)" from
 * docs/reference/mythos-harness-reference.md section 1 (web_search) and the
 * section 4 mapping row "Scale tool calls to complexity -> router triage". The
 * router triages task kind and criteria; this module turns the surface signals
 * of a triaged task (criteria count, description length, kind) into a retry and
 * tool budget so a high-complexity research task gets more attempts and a wider
 * tool budget than a one-shot code fact.
 *
 * Everything here is pure and dependency-light (zod for boundary validation
 * only) so the engine can call it during planning, after routing and before the
 * ledger write, to set per-task maxAttempts deterministically without any model
 * call or new config knob.
 */

/** Estimated complexity of a task, low to high. */
export const ComplexityTierSchema = z.enum(["low", "medium", "high"]);
export type ComplexityTier = z.infer<typeof ComplexityTierSchema>;

/**
 * A scaled budget for one task. `maxAttempts` caps verification retries;
 * `toolBudget` is an advisory ceiling on tool calls a worker should spend,
 * mirroring the harness "1 / 3-5 / 5-10" web-search scaling. Both grow with
 * tier.
 */
export const TaskBudgetSchema = z.object({
  tier: ComplexityTierSchema,
  maxAttempts: z.number().int().min(1),
  toolBudget: z.number().int().min(1),
});
export type TaskBudget = z.infer<typeof TaskBudgetSchema>;

/**
 * The minimal shape estimateComplexity reads. A superset of this (for example a
 * full DagTask) is accepted; only these fields are consulted, and the input is
 * never mutated.
 */
export interface ComplexityInput {
  description: string;
  acceptanceCriteria: string[];
  kind: "code" | "generic" | "research";
}

// Heuristic boundaries. Hard-coded per the Phase 2.5 design (risk note: extract
// to a ComplexityBudgetConfig only if monitoring shows tuning is needed). The
// score is a small integer "criteria-equivalent" count; tiers map to the harness
// "1 fact / 3-5 medium / 5-10 research" bands.
const MEDIUM_SCORE_THRESHOLD = 3; // score >= 3 is at least medium
const HIGH_SCORE_THRESHOLD = 5; // score >= 5 is high
const LONG_DESCRIPTION_CHARS = 500; // a long brief adds 1 to the score
const VERY_LONG_DESCRIPTION_CHARS = 1_200; // a very long brief adds another 1

const TIER_ORDER: readonly ComplexityTier[] = ["low", "medium", "high"];

/** Bump a tier up by `steps`, clamped at "high". Never bumps past "high". */
function bumpTier(tier: ComplexityTier, steps: number): ComplexityTier {
  const idx = TIER_ORDER.indexOf(tier);
  const next = Math.min(idx + Math.max(0, steps), TIER_ORDER.length - 1);
  return TIER_ORDER[next] as ComplexityTier;
}

function tierFromScore(score: number): ComplexityTier {
  if (score >= HIGH_SCORE_THRESHOLD) return "high";
  if (score >= MEDIUM_SCORE_THRESHOLD) return "medium";
  return "low";
}

/**
 * Deterministically estimate a task's complexity from cheap surface signals:
 *
 *  - acceptance criteria count (the dominant signal: more checkable criteria
 *    means more surface area to satisfy),
 *  - description length (a long, dense brief adds to the score),
 *  - kind ("research" boosts the tier by one band, since research tasks are
 *    open-ended; "code" and "generic" do not boost).
 *
 * Pure: the input is read but never mutated, and the result depends only on the
 * input. Mirrors the harness "1 fact / 3-5 medium / 5-10 research" rule.
 */
export function estimateComplexity(task: ComplexityInput): ComplexityTier {
  const criteriaCount = task.acceptanceCriteria.length;
  const descLength = task.description.length;

  let score = criteriaCount;
  if (descLength > LONG_DESCRIPTION_CHARS) score += 1;
  if (descLength > VERY_LONG_DESCRIPTION_CHARS) score += 1;

  let tier = tierFromScore(score);

  // Research is inherently open-ended: boost one band unless already high.
  if (task.kind === "research") {
    tier = bumpTier(tier, 1);
  }

  return tier;
}

/**
 * Map a tier to a concrete TaskBudget, scaled around the configured worker
 * defaults so the budget stays in step with the rest of the config rather than
 * inventing detached magic numbers.
 *
 *  - maxAttempts: medium anchors on config.worker.maxAttempts (the existing
 *    default), low is one fewer (floored at 2 so even simple tasks get a retry),
 *    and high is the anchor plus headroom (floored at 5) to mirror the
 *    "5-10 research" upper band.
 *  - toolBudget: scaled from the worker allowlist size as the medium baseline,
 *    halved for low and doubled for high, echoing the harness 1 / 3-5 / 5-10
 *    call-count scaling.
 *
 * Pure: depends only on (tier, config). Validated at the boundary so a
 * malformed config surfaces immediately rather than producing a bad budget.
 */
export function budgetForTier(tier: ComplexityTier, config: MagnesiumConfig): TaskBudget {
  const baseAttempts = config.worker.maxAttempts;
  const baseTools = config.worker.allowedTools.length;

  let maxAttempts: number;
  let toolBudget: number;

  switch (tier) {
    case "low":
      maxAttempts = Math.max(2, baseAttempts - 1);
      toolBudget = Math.max(1, Math.ceil(baseTools / 2));
      break;
    case "medium":
      maxAttempts = Math.max(3, baseAttempts);
      toolBudget = Math.max(1, baseTools);
      break;
    case "high":
      maxAttempts = Math.max(5, baseAttempts + 2);
      toolBudget = Math.max(1, baseTools * 2);
      break;
  }

  return TaskBudgetSchema.parse({ tier, maxAttempts, toolBudget });
}

/** A planned task that carries enough to estimate and apply a complexity budget. */
export interface BudgetablePlannedTask {
  description: string;
  acceptanceCriteria: string[];
  kind: "code" | "generic" | "research";
  maxAttempts: number;
}

/** A planned task hydrated with its scaled budget. */
export type BudgetedPlannedTask<T extends BudgetablePlannedTask> = T & {
  maxAttempts: number;
  complexityTier: ComplexityTier;
  toolBudget: number;
};

/**
 * Apply complexity budgeting to a list of planned tasks. For each task, estimate
 * the tier, derive the scaled budget, and return a new task object with
 * maxAttempts overridden and the tier plus toolBudget attached for the ledger
 * metadata and observability. Pure: inputs are not mutated; a new array of new
 * objects is returned, preserving order.
 *
 * The engine calls this in plan() after routeTasks() and before
 * ledger.createTask(), keyed by the estimated tier.
 */
export function applyComplexityBudgets<T extends BudgetablePlannedTask>(
  tasks: readonly T[],
  config: MagnesiumConfig,
): BudgetedPlannedTask<T>[] {
  return tasks.map((task) => {
    const tier = estimateComplexity(task);
    const budget = budgetForTier(tier, config);
    return {
      ...task,
      maxAttempts: budget.maxAttempts,
      complexityTier: tier,
      toolBudget: budget.toolBudget,
    };
  });
}
