import { requireApiKey } from "../config/load";
import type { MagnesiumConfig } from "../config/schema";
import type { LedgerRepository } from "../ledger/repository";
import { SqliteLedger } from "../ledger/sqlite/sqlite-ledger";
import type { Logger } from "../logging/logger";
import { AnthropicModelClient } from "../models/anthropic-client";
import type { ModelClient } from "../models/types";
import { CodeTestVerifier } from "../verification/code-test-verifier";
import { CompositeVerifier } from "../verification/composite-verifier";
import { CriticVerifier } from "../verification/critic-verifier";
import { PolicyCriticVerifier } from "../verification/policy-critic-verifier";
import { PolicyGatedVerifier } from "../verification/policy-gated-verifier";
import type { Verifier } from "../verification/verifier";
import { createWorker, LocalWorkerPool } from "../workers/pool";
import { WorkspaceManager } from "../workers/worktree";
import { MagnesiumEngine } from "./engine";
import { RunControlRegistry } from "./run-control";

export function openLedger(config: MagnesiumConfig): LedgerRepository {
  return new SqliteLedger(config.paths.ledger);
}

export interface EngineBundle {
  engine: MagnesiumEngine;
  ledger: LedgerRepository;
  client: ModelClient;
  /** Shared pause/resume registry; pass to a control plane to drive the engine. */
  control: RunControlRegistry;
}

export interface CreateEngineOptions {
  ledger?: LedgerRepository;
  client?: ModelClient;
}

/**
 * Wires the full engine: ledger, model client, workspace manager, worker pool,
 * and the composite verifier. Dependencies can be overridden (tests inject a
 * stub client and an in-memory or temp-file ledger).
 */
export function createEngine(
  config: MagnesiumConfig,
  logger: Logger,
  opts: CreateEngineOptions = {},
): EngineBundle {
  const ledger = opts.ledger ?? openLedger(config);
  const client =
    opts.client ?? new AnthropicModelClient({ apiKey: requireApiKey(), pricing: config.pricing });
  const workspace = new WorkspaceManager(config.paths.worktrees, logger);
  const pool = new LocalWorkerPool(createWorker(config, logger), config.concurrency, logger);
  const baseVerifier = new CompositeVerifier(
    new CodeTestVerifier(config.verify.testCommand, config.verify.testTimeoutMs),
    new CriticVerifier(client, config),
  );
  // Phase 2.5: gate every verdict by the policy critic when enabled (default off).
  const verifier: Verifier = config.verify.policyGate
    ? new PolicyGatedVerifier(baseVerifier, new PolicyCriticVerifier(client, config))
    : baseVerifier;
  const control = new RunControlRegistry();
  const engine = new MagnesiumEngine({
    ledger,
    client,
    config,
    logger,
    workspace,
    pool,
    verifier,
    control,
  });
  return { engine, ledger, client, control };
}
