// Programmatic entry point. The CLI (src/cli/main.ts) is the primary surface;
// these exports let Magnesium be embedded or driven from tests and scripts.
export { loadConfig, requireApiKey } from "./config/load";
export { defaultConfig } from "./config/defaults";
export type { MagnesiumConfig } from "./config/schema";
export { createLogger, type Logger } from "./logging/logger";
export { SqliteLedger } from "./ledger/sqlite/sqlite-ledger";
export type { LedgerRepository } from "./ledger/repository";
export * from "./ledger/types";
export { MagnesiumEngine } from "./runtime/engine";
export { createEngine, openLedger } from "./runtime/bootstrap";
export type { ModelClient, StructuredRequest, ModelCallResult } from "./models/types";
export { AnthropicModelClient } from "./models/anthropic-client";
export { validateDag, detectCycle, topoSort, computeReady } from "./orchestrator/dag";
export { runVerificationGate } from "./verification/gate";
export type { Verifier, Verdict, VerifyInput } from "./verification/verifier";
export type { WorkerAdapter, WorkerTask, WorkerResult } from "./workers/worker";
export { buildContainerInvocation, buildClaudeArgs } from "./workers/claude-invocation";

// Phase 2 capabilities.
// Observability / reporting (pure functions over ledger rows).
export { costReport, formatCostReport, type CostReportSummary } from "./reporting/cost-report";
export { formatEvents, type EventStreamFormat } from "./reporting/event-stream";
export { renderTaskDag, buildDagNodes } from "./reporting/dag-render";
// LLM context compaction (with deterministic fallback).
export { summarizeTasks, fallbackSummary, type SummarizeResult } from "./orchestrator/summarize";
// Router-driven task triage.
export { routeTasks, type RoutedTask } from "./orchestrator/route";
// Telegram control surface (transport-abstracted; grammy adapter isolated).
export { TelegramControlSurface, type RunSupervisor } from "./supervisor/telegram/surface";
export { TelegramConfirmationGate } from "./supervisor/telegram/confirmation";
export type {
  TelegramTransport,
  TelegramCommand,
  TelegramCallback,
  TelegramMessage,
} from "./supervisor/telegram/transport";
export { createGrammyTransport, GrammyTransport } from "./supervisor/telegram/grammy-adapter";
// AIP distributed worker dispatch seam.
export {
  parseAipDid,
  formatAipDid,
  AipDispatcher,
  LoopbackWorker,
  MemoryWorkerRegistry,
  DidResolutionError,
  type AipDid,
  type WorkerRegistry,
} from "./workers/aip/index";
