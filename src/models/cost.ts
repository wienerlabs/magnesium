import type { PriceRate } from "../config/schema";
import type { TokenUsage } from "./types";

/**
 * Computes USD cost from token usage and a price table. Rates ALWAYS come from
 * config (marked VERIFY); there are no price literals here. Used for direct SDK
 * calls. Workers self-report total_cost_usd and do not use this path.
 */
export function computeCostUsd(
  model: string,
  usage: TokenUsage,
  pricing: Record<string, PriceRate>,
): number {
  const rate = pricing[model] ?? pricing.default;
  if (!rate) return 0;
  const perM = 1_000_000;
  return (
    (usage.inputTokens / perM) * rate.inputPerMTok +
    (usage.outputTokens / perM) * rate.outputPerMTok +
    (usage.cacheReadTokens / perM) * rate.cacheReadPerMTok +
    (usage.cacheCreationTokens / perM) * rate.cacheWritePerMTok
  );
}
