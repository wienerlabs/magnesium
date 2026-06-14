import type {
  ArtifactRow,
  ArtifactType,
  CheckpointRow,
  EventRow,
  LlmCallRow,
  LlmPurpose,
  RunRow,
  RunStatus,
  TaskDep,
  TaskKind,
  TaskRow,
  TaskStatus,
} from "./types";

export interface CreateRunInput {
  id?: string;
  goal: string;
  workspaceDir: string;
  budgetUsdCap: number;
  modelOrchestrator: string;
  modelRouter: string;
  baseCommit?: string | null;
  integrationBranch?: string | null;
  metadata?: Record<string, unknown>;
}

export interface CreateTaskInput {
  id?: string;
  runId: string;
  parentId?: string | null;
  slug: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  kind: TaskKind;
  maxAttempts: number;
  model?: string | null;
}

export interface TaskPatch {
  status?: TaskStatus;
  attempt?: number;
  worktreePath?: string | null;
  branch?: string | null;
  workerSessionId?: string | null;
  costUsd?: number;
  resultSummary?: string | null;
  error?: string | null;
}

export interface CreateArtifactInput {
  id?: string;
  taskId: string;
  type: ArtifactType;
  path?: string | null;
  sha256?: string | null;
  metadata?: Record<string, unknown>;
}

export interface AppendEventInput {
  runId: string;
  taskId?: string | null;
  type: string;
  payload?: Record<string, unknown>;
}

export interface RecordLlmCallInput {
  runId: string;
  taskId?: string | null;
  purpose: LlmPurpose;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
}

/**
 * The single storage boundary. The SQLite implementation is the only thing that
 * touches raw SQL. Swapping to Postgres or an external WienerLog service means
 * providing another implementation of this interface and nothing else changes.
 */
export interface LedgerRepository {
  // Runs
  createRun(input: CreateRunInput): RunRow;
  getRun(id: string): RunRow | null;
  listRuns(): RunRow[];
  updateRunStatus(id: string, status: RunStatus): void;
  setRunIntegration(id: string, integrationBranch: string, baseCommit: string): void;
  setRunBaseCommit(id: string, baseCommit: string): void;
  setRunBudgetCap(id: string, capUsd: number): void;
  addRunCost(id: string, deltaUsd: number): number;

  // Tasks
  createTask(input: CreateTaskInput): TaskRow;
  getTask(id: string): TaskRow | null;
  listTasks(runId: string): TaskRow[];
  updateTask(id: string, patch: TaskPatch): TaskRow;

  // Dependencies
  addDep(taskId: string, dependsOnId: string): void;
  listDeps(runId: string): TaskDep[];

  // Artifacts
  recordArtifact(input: CreateArtifactInput): ArtifactRow;
  listArtifacts(taskId: string): ArtifactRow[];

  // Events (append-only audit log)
  appendEvent(input: AppendEventInput): EventRow;
  listEvents(runId: string, sinceSeq?: number): EventRow[];

  // Cost ledger
  recordLlmCall(input: RecordLlmCallInput): LlmCallRow;
  listLlmCalls(runId: string): LlmCallRow[];

  // Checkpoints (compacted orchestrator state)
  saveCheckpoint(runId: string, digest: Record<string, unknown>): CheckpointRow;
  loadLatestCheckpoint(runId: string): CheckpointRow | null;

  // Atomic multi-statement transitions
  transaction<T>(fn: () => T): T;

  close(): void;
}
