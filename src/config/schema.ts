import { z } from "zod";

/**
 * Per-model price rates, expressed in USD per million tokens. These are read by
 * the cost module and MUST NOT be hardcoded anywhere in logic. They feed cost
 * accounting for direct SDK calls only; workers self-report total_cost_usd.
 */
export const PriceRateSchema = z.object({
  inputPerMTok: z.number().nonnegative(),
  outputPerMTok: z.number().nonnegative(),
  cacheReadPerMTok: z.number().nonnegative(),
  cacheWritePerMTok: z.number().nonnegative(),
});
export type PriceRate = z.infer<typeof PriceRateSchema>;

export const ModelsConfigSchema = z.object({
  orchestrator: z.string().min(1),
  router: z.string().min(1),
  critic: z.string().min(1),
  workerDefault: z.string().min(1),
  fallback: z.string().min(1),
  orchestratorThinkingTokens: z.number().int().positive(),
});

export const BudgetConfigSchema = z.object({
  capUsd: z.number().positive(),
  perWorkerCapUsd: z.number().positive(),
});

export const WorkerConfigSchema = z.object({
  maxAttempts: z.number().int().min(1),
  timeoutMs: z.number().int().positive(),
  permissionMode: z.enum(["default", "acceptEdits", "plan"]),
  allowedTools: z.array(z.string()).min(1),
});

export const ContainerConfigSchema = z.object({
  enabled: z.boolean(),
  runtime: z.enum(["orbstack", "docker"]),
  image: z.string().min(1),
  network: z.string().min(1),
});

export const VerifyConfigSchema = z.object({
  testCommand: z.string().min(1),
  testTimeoutMs: z.number().int().positive(),
});

export const PathsConfigSchema = z.object({
  ledger: z.string().min(1),
  worktrees: z.string().min(1),
  workspaces: z.string().min(1),
  logs: z.string().min(1),
});

export const MagnesiumConfigSchema = z.object({
  models: ModelsConfigSchema,
  budget: BudgetConfigSchema,
  concurrency: z.number().int().min(1),
  worker: WorkerConfigSchema,
  container: ContainerConfigSchema,
  verify: VerifyConfigSchema,
  paths: PathsConfigSchema,
  /** Rates marked VERIFY. Keyed by model id, plus a "default" fallback entry. */
  pricing: z.record(z.string(), PriceRateSchema),
});

export type MagnesiumConfig = z.infer<typeof MagnesiumConfigSchema>;
