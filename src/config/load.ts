import { ConfigError } from "../util/errors";
import { defaultConfig } from "./defaults";
import { MagnesiumConfigSchema, type MagnesiumConfig } from "./schema";

function num(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Builds the effective config: defaults overlaid with environment variables,
 * then validated. Operational values are overridable via env; price rates are
 * intentionally not env-overridable and live in defaults.ts marked VERIFY.
 */
/**
 * Per-section partial overrides for loadConfig. Each section may be supplied
 * partially (e.g. only verify.testCommand); the defaults fill the rest. This keeps
 * callers from having to specify a whole section when they only tune one field.
 */
export interface ConfigOverrides {
  models?: Partial<MagnesiumConfig["models"]>;
  budget?: Partial<MagnesiumConfig["budget"]>;
  worker?: Partial<MagnesiumConfig["worker"]>;
  container?: Partial<MagnesiumConfig["container"]>;
  verify?: Partial<MagnesiumConfig["verify"]>;
  paths?: Partial<MagnesiumConfig["paths"]>;
  pricing?: MagnesiumConfig["pricing"];
  concurrency?: number;
}

export function loadConfig(overrides: ConfigOverrides = {}): MagnesiumConfig {
  const base: MagnesiumConfig = structuredClone(defaultConfig);

  const budgetCap = num(process.env.MAGNESIUM_BUDGET_USD);
  if (budgetCap !== undefined) base.budget.capUsd = budgetCap;

  const perWorker = num(process.env.MAGNESIUM_PER_WORKER_BUDGET_USD);
  if (perWorker !== undefined) base.budget.perWorkerCapUsd = perWorker;

  const concurrency = num(process.env.MAGNESIUM_CONCURRENCY);
  if (concurrency !== undefined) base.concurrency = concurrency;

  if (process.env.MAGNESIUM_WORKER_IMAGE) {
    base.container.image = process.env.MAGNESIUM_WORKER_IMAGE;
  }
  const runtime = process.env.MAGNESIUM_CONTAINER_RUNTIME;
  if (runtime === "orbstack" || runtime === "docker") {
    base.container.runtime = runtime;
  }
  if (process.env.MAGNESIUM_CONTAINER_DISABLED === "1") {
    base.container.enabled = false;
  }

  const merged: MagnesiumConfig = {
    ...base,
    ...overrides,
    models: { ...base.models, ...overrides.models },
    budget: { ...base.budget, ...overrides.budget },
    worker: { ...base.worker, ...overrides.worker },
    container: { ...base.container, ...overrides.container },
    verify: { ...base.verify, ...overrides.verify },
    paths: { ...base.paths, ...overrides.paths },
    pricing: { ...base.pricing, ...overrides.pricing },
  };

  const parsed = MagnesiumConfigSchema.safeParse(merged);
  if (!parsed.success) {
    throw new ConfigError(`invalid configuration: ${parsed.error.message}`);
  }
  return parsed.data;
}

export function requireApiKey(): string {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || key.trim() === "") {
    throw new ConfigError(
      "ANTHROPIC_API_KEY is not set. Phase 1 uses metered API billing for both " +
        "the orchestrator and workers. Set it in your environment or .env.",
    );
  }
  return key;
}
