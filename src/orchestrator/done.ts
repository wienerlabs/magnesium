import type { MagnesiumConfig } from "../config/schema";
import { DoneDecisionSchema, type DoneDecision } from "../models/schemas";
import type { ModelClient, TokenUsage } from "../models/types";
import type { RunDigest } from "./compaction";

const SYSTEM = [
  "You are the orchestrator deciding whether a multi-agent run has satisfied the",
  "user's goal, based on a compact digest of completed and failed tasks. Be",
  "honest: if required work failed or is missing, the goal is not done. Return",
  "your decision via the tool.",
].join(" ");

export interface DoneResult {
  decision: DoneDecision;
  usage: TokenUsage;
  costUsd: number;
  model: string;
}

export async function decideDone(
  client: ModelClient,
  config: MagnesiumConfig,
  digest: RunDigest,
): Promise<DoneResult> {
  const user = [
    `Goal:`,
    digest.goal,
    "",
    "Run digest:",
    JSON.stringify(digest, null, 2),
  ].join("\n");

  const { value, usage, costUsd, model } = await client.structured({
    purpose: "integrate",
    model: config.models.orchestrator,
    system: SYSTEM,
    user,
    schema: DoneDecisionSchema,
    schemaName: "done_decision",
    schemaDescription: "Whether the goal is satisfied",
  });

  return { decision: value, usage, costUsd, model };
}
