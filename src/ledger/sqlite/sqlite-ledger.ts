import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import Database from "better-sqlite3";

import { nowIso, uuid } from "../../util/ids";
import type {
  AppendEventInput,
  CreateArtifactInput,
  CreateRunInput,
  CreateTaskInput,
  LedgerRepository,
  RecordLlmCallInput,
  TaskPatch,
} from "../repository";
import type {
  ArtifactRow,
  CheckpointRow,
  EventRow,
  LlmCallRow,
  RunRow,
  RunStatus,
  TaskDep,
  TaskRow,
} from "../types";
import { applyMigrations } from "./migrations";

type Raw = Record<string, unknown>;

function mapRun(r: Raw): RunRow {
  return {
    id: r.id as string,
    goal: r.goal as string,
    status: r.status as RunStatus,
    workspaceDir: r.workspace_dir as string,
    baseCommit: (r.base_commit as string | null) ?? null,
    integrationBranch: (r.integration_branch as string | null) ?? null,
    budgetUsdCap: r.budget_usd_cap as number,
    costUsdSpent: r.cost_usd_spent as number,
    modelOrchestrator: r.model_orchestrator as string,
    modelRouter: r.model_router as string,
    metadata: JSON.parse((r.metadata as string) ?? "{}"),
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

function mapTask(r: Raw): TaskRow {
  return {
    id: r.id as string,
    runId: r.run_id as string,
    parentId: (r.parent_id as string | null) ?? null,
    slug: r.slug as string,
    title: r.title as string,
    description: r.description as string,
    acceptanceCriteria: JSON.parse((r.acceptance_criteria as string) ?? "[]"),
    kind: r.kind as TaskRow["kind"],
    status: r.status as TaskRow["status"],
    attempt: r.attempt as number,
    maxAttempts: r.max_attempts as number,
    model: (r.model as string | null) ?? null,
    worktreePath: (r.worktree_path as string | null) ?? null,
    branch: (r.branch as string | null) ?? null,
    workerSessionId: (r.worker_session_id as string | null) ?? null,
    costUsd: r.cost_usd as number,
    resultSummary: (r.result_summary as string | null) ?? null,
    error: (r.error as string | null) ?? null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

function mapArtifact(r: Raw): ArtifactRow {
  return {
    id: r.id as string,
    taskId: r.task_id as string,
    type: r.type as ArtifactRow["type"],
    path: (r.path as string | null) ?? null,
    sha256: (r.sha256 as string | null) ?? null,
    metadata: JSON.parse((r.metadata as string) ?? "{}"),
    createdAt: r.created_at as string,
  };
}

function mapEvent(r: Raw): EventRow {
  return {
    id: r.id as string,
    runId: r.run_id as string,
    taskId: (r.task_id as string | null) ?? null,
    seq: r.seq as number,
    type: r.type as string,
    payload: JSON.parse((r.payload as string) ?? "{}"),
    createdAt: r.created_at as string,
  };
}

function mapLlmCall(r: Raw): LlmCallRow {
  return {
    id: r.id as string,
    runId: r.run_id as string,
    taskId: (r.task_id as string | null) ?? null,
    purpose: r.purpose as LlmCallRow["purpose"],
    model: r.model as string,
    inputTokens: r.input_tokens as number,
    outputTokens: r.output_tokens as number,
    cacheReadTokens: r.cache_read_tokens as number,
    cacheCreationTokens: r.cache_creation_tokens as number,
    costUsd: r.cost_usd as number,
    createdAt: r.created_at as string,
  };
}

function mapCheckpoint(r: Raw): CheckpointRow {
  return {
    id: r.id as string,
    runId: r.run_id as string,
    seq: r.seq as number,
    digest: JSON.parse((r.digest as string) ?? "{}"),
    createdAt: r.created_at as string,
  };
}

const TASK_PATCH_COLUMNS: Record<keyof TaskPatch, string> = {
  status: "status",
  attempt: "attempt",
  worktreePath: "worktree_path",
  branch: "branch",
  workerSessionId: "worker_session_id",
  costUsd: "cost_usd",
  resultSummary: "result_summary",
  error: "error",
};

export class SqliteLedger implements LedgerRepository {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    // WAL plus FULL durability so a kill -9 cannot tear the last committed
    // state transition. This is the explicit Phase 1 resume guarantee.
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = FULL");
    this.db.pragma("foreign_keys = ON");
    applyMigrations(this.db);
  }

  // --- Runs ---

  createRun(input: CreateRunInput): RunRow {
    const id = input.id ?? uuid();
    const ts = nowIso();
    this.db
      .prepare(
        `INSERT INTO runs (id, goal, status, workspace_dir, base_commit,
          integration_branch, budget_usd_cap, cost_usd_spent, model_orchestrator,
          model_router, metadata, created_at, updated_at)
         VALUES (@id, @goal, 'created', @workspaceDir, @baseCommit,
          @integrationBranch, @budgetUsdCap, 0, @modelOrchestrator,
          @modelRouter, @metadata, @ts, @ts)`,
      )
      .run({
        id,
        goal: input.goal,
        workspaceDir: input.workspaceDir,
        baseCommit: input.baseCommit ?? null,
        integrationBranch: input.integrationBranch ?? null,
        budgetUsdCap: input.budgetUsdCap,
        modelOrchestrator: input.modelOrchestrator,
        modelRouter: input.modelRouter,
        metadata: JSON.stringify(input.metadata ?? {}),
        ts,
      });
    return this.getRun(id) as RunRow;
  }

  getRun(id: string): RunRow | null {
    const r = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as Raw | undefined;
    return r ? mapRun(r) : null;
  }

  listRuns(): RunRow[] {
    const rows = this.db.prepare("SELECT * FROM runs ORDER BY created_at DESC").all() as Raw[];
    return rows.map(mapRun);
  }

  updateRunStatus(id: string, status: RunStatus): void {
    this.db
      .prepare("UPDATE runs SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, nowIso(), id);
  }

  setRunIntegration(id: string, integrationBranch: string, baseCommit: string): void {
    this.db
      .prepare(
        "UPDATE runs SET integration_branch = ?, base_commit = ?, updated_at = ? WHERE id = ?",
      )
      .run(integrationBranch, baseCommit, nowIso(), id);
  }

  setRunBaseCommit(id: string, baseCommit: string): void {
    this.db
      .prepare("UPDATE runs SET base_commit = ?, updated_at = ? WHERE id = ?")
      .run(baseCommit, nowIso(), id);
  }

  setRunBudgetCap(id: string, capUsd: number): void {
    this.db
      .prepare("UPDATE runs SET budget_usd_cap = ?, updated_at = ? WHERE id = ?")
      .run(capUsd, nowIso(), id);
  }

  addRunCost(id: string, deltaUsd: number): number {
    return this.transaction(() => {
      this.db
        .prepare("UPDATE runs SET cost_usd_spent = cost_usd_spent + ?, updated_at = ? WHERE id = ?")
        .run(deltaUsd, nowIso(), id);
      const r = this.db.prepare("SELECT cost_usd_spent FROM runs WHERE id = ?").get(id) as
        | { cost_usd_spent: number }
        | undefined;
      return r?.cost_usd_spent ?? 0;
    });
  }

  // --- Tasks ---

  createTask(input: CreateTaskInput): TaskRow {
    const id = input.id ?? uuid();
    const ts = nowIso();
    this.db
      .prepare(
        `INSERT INTO tasks (id, run_id, parent_id, slug, title, description,
          acceptance_criteria, kind, status, attempt, max_attempts, model,
          cost_usd, created_at, updated_at)
         VALUES (@id, @runId, @parentId, @slug, @title, @description,
          @acceptanceCriteria, @kind, 'pending', 0, @maxAttempts, @model,
          0, @ts, @ts)`,
      )
      .run({
        id,
        runId: input.runId,
        parentId: input.parentId ?? null,
        slug: input.slug,
        title: input.title,
        description: input.description,
        acceptanceCriteria: JSON.stringify(input.acceptanceCriteria),
        kind: input.kind,
        maxAttempts: input.maxAttempts,
        model: input.model ?? null,
        ts,
      });
    return this.getTask(id) as TaskRow;
  }

  getTask(id: string): TaskRow | null {
    const r = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Raw | undefined;
    return r ? mapTask(r) : null;
  }

  listTasks(runId: string): TaskRow[] {
    const rows = this.db
      .prepare("SELECT * FROM tasks WHERE run_id = ? ORDER BY created_at ASC")
      .all(runId) as Raw[];
    return rows.map(mapTask);
  }

  updateTask(id: string, patch: TaskPatch): TaskRow {
    const sets: string[] = [];
    const params: Raw = { id, updated_at: nowIso() };
    for (const key of Object.keys(patch) as (keyof TaskPatch)[]) {
      const column = TASK_PATCH_COLUMNS[key];
      sets.push(`${column} = @${key}`);
      params[key] = patch[key] ?? null;
    }
    if (sets.length > 0) {
      this.db
        .prepare(`UPDATE tasks SET ${sets.join(", ")}, updated_at = @updated_at WHERE id = @id`)
        .run(params);
    }
    return this.getTask(id) as TaskRow;
  }

  // --- Dependencies ---

  addDep(taskId: string, dependsOnId: string): void {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO task_deps (task_id, depends_on_id) VALUES (?, ?)",
      )
      .run(taskId, dependsOnId);
  }

  listDeps(runId: string): TaskDep[] {
    const rows = this.db
      .prepare(
        `SELECT d.task_id AS taskId, d.depends_on_id AS dependsOnId
         FROM task_deps d
         JOIN tasks t ON t.id = d.task_id
         WHERE t.run_id = ?`,
      )
      .all(runId) as Raw[];
    return rows.map((r) => ({ taskId: r.taskId as string, dependsOnId: r.dependsOnId as string }));
  }

  // --- Artifacts ---

  recordArtifact(input: CreateArtifactInput): ArtifactRow {
    const id = input.id ?? uuid();
    const createdAt = nowIso();
    this.db
      .prepare(
        `INSERT INTO artifacts (id, task_id, type, path, sha256, metadata, created_at)
         VALUES (@id, @taskId, @type, @path, @sha256, @metadata, @createdAt)`,
      )
      .run({
        id,
        taskId: input.taskId,
        type: input.type,
        path: input.path ?? null,
        sha256: input.sha256 ?? null,
        metadata: JSON.stringify(input.metadata ?? {}),
        createdAt,
      });
    const r = this.db.prepare("SELECT * FROM artifacts WHERE id = ?").get(id) as Raw;
    return mapArtifact(r);
  }

  listArtifacts(taskId: string): ArtifactRow[] {
    const rows = this.db
      .prepare("SELECT * FROM artifacts WHERE task_id = ? ORDER BY created_at ASC")
      .all(taskId) as Raw[];
    return rows.map(mapArtifact);
  }

  // --- Events ---

  appendEvent(input: AppendEventInput): EventRow {
    return this.transaction(() => {
      const seqRow = this.db
        .prepare("SELECT COALESCE(MAX(seq), 0) AS m FROM events WHERE run_id = ?")
        .get(input.runId) as { m: number };
      const seq = seqRow.m + 1;
      const id = uuid();
      const createdAt = nowIso();
      this.db
        .prepare(
          `INSERT INTO events (id, run_id, task_id, seq, type, payload, created_at)
           VALUES (@id, @runId, @taskId, @seq, @type, @payload, @createdAt)`,
        )
        .run({
          id,
          runId: input.runId,
          taskId: input.taskId ?? null,
          seq,
          type: input.type,
          payload: JSON.stringify(input.payload ?? {}),
          createdAt,
        });
      return {
        id,
        runId: input.runId,
        taskId: input.taskId ?? null,
        seq,
        type: input.type,
        payload: input.payload ?? {},
        createdAt,
      };
    });
  }

  listEvents(runId: string, sinceSeq = 0): EventRow[] {
    const rows = this.db
      .prepare("SELECT * FROM events WHERE run_id = ? AND seq > ? ORDER BY seq ASC")
      .all(runId, sinceSeq) as Raw[];
    return rows.map(mapEvent);
  }

  // --- Cost ledger ---

  recordLlmCall(input: RecordLlmCallInput): LlmCallRow {
    const id = uuid();
    const createdAt = nowIso();
    this.db
      .prepare(
        `INSERT INTO llm_calls (id, run_id, task_id, purpose, model, input_tokens,
          output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd, created_at)
         VALUES (@id, @runId, @taskId, @purpose, @model, @inputTokens,
          @outputTokens, @cacheReadTokens, @cacheCreationTokens, @costUsd, @createdAt)`,
      )
      .run({
        id,
        runId: input.runId,
        taskId: input.taskId ?? null,
        purpose: input.purpose,
        model: input.model,
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
        cacheReadTokens: input.cacheReadTokens,
        cacheCreationTokens: input.cacheCreationTokens,
        costUsd: input.costUsd,
        createdAt,
      });
    const r = this.db.prepare("SELECT * FROM llm_calls WHERE id = ?").get(id) as Raw;
    return mapLlmCall(r);
  }

  listLlmCalls(runId: string): LlmCallRow[] {
    const rows = this.db
      .prepare("SELECT * FROM llm_calls WHERE run_id = ? ORDER BY created_at ASC")
      .all(runId) as Raw[];
    return rows.map(mapLlmCall);
  }

  // --- Checkpoints ---

  saveCheckpoint(runId: string, digest: Record<string, unknown>): CheckpointRow {
    return this.transaction(() => {
      const seqRow = this.db
        .prepare("SELECT COALESCE(MAX(seq), 0) AS m FROM checkpoints WHERE run_id = ?")
        .get(runId) as { m: number };
      const seq = seqRow.m + 1;
      const id = uuid();
      const createdAt = nowIso();
      this.db
        .prepare(
          `INSERT INTO checkpoints (id, run_id, seq, digest, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(id, runId, seq, JSON.stringify(digest), createdAt);
      return { id, runId, seq, digest, createdAt };
    });
  }

  loadLatestCheckpoint(runId: string): CheckpointRow | null {
    const r = this.db
      .prepare("SELECT * FROM checkpoints WHERE run_id = ? ORDER BY seq DESC LIMIT 1")
      .get(runId) as Raw | undefined;
    return r ? mapCheckpoint(r) : null;
  }

  // --- Transactions / lifecycle ---

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  close(): void {
    this.db.close();
  }
}
