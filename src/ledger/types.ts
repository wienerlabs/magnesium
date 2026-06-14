export type RunStatus =
  | "created"
  | "planning"
  | "running"
  | "integrating"
  | "completed"
  | "failed"
  | "aborted"
  | "paused";

export type TaskKind = "code" | "generic" | "research";

export type TaskStatus =
  | "pending"
  | "ready"
  | "dispatched"
  | "running"
  | "verifying"
  | "verified"
  | "integrated"
  | "failed"
  | "blocked"
  | "cancelled";

export const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = [
  "integrated",
  "failed",
  "blocked",
  "cancelled",
];

/** Statuses that mean a worker was in flight when the process died. */
export const IN_FLIGHT_TASK_STATUSES: readonly TaskStatus[] = [
  "dispatched",
  "running",
  "verifying",
];

export type ArtifactType = "diff" | "file" | "test_report" | "critic_report" | "log";

export type LlmPurpose = "decompose" | "route" | "critic" | "compact" | "integrate" | "worker";

export interface RunRow {
  id: string;
  goal: string;
  status: RunStatus;
  workspaceDir: string;
  baseCommit: string | null;
  integrationBranch: string | null;
  budgetUsdCap: number;
  costUsdSpent: number;
  modelOrchestrator: string;
  modelRouter: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface TaskRow {
  id: string;
  runId: string;
  parentId: string | null;
  slug: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  kind: TaskKind;
  status: TaskStatus;
  attempt: number;
  maxAttempts: number;
  model: string | null;
  worktreePath: string | null;
  branch: string | null;
  workerSessionId: string | null;
  costUsd: number;
  resultSummary: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskDep {
  taskId: string;
  dependsOnId: string;
}

export interface ArtifactRow {
  id: string;
  taskId: string;
  type: ArtifactType;
  path: string | null;
  sha256: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface EventRow {
  id: string;
  runId: string;
  taskId: string | null;
  seq: number;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface LlmCallRow {
  id: string;
  runId: string;
  taskId: string | null;
  purpose: LlmPurpose;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  createdAt: string;
}

export interface CheckpointRow {
  id: string;
  runId: string;
  seq: number;
  digest: Record<string, unknown>;
  createdAt: string;
}
