import type { MagnesiumConfig } from "../config/schema";
import type { LedgerRepository } from "../ledger/repository";
import { IN_FLIGHT_TASK_STATUSES, type RunRow } from "../ledger/types";
import type { Logger } from "../logging/logger";
import type { ModelClient } from "../models/types";
import { compactRun } from "../orchestrator/compaction";
import { computeReady } from "../orchestrator/dag";
import { decompose } from "../orchestrator/decompose";
import { decideDone } from "../orchestrator/done";
import { integrateRun } from "../orchestrator/integrate";
import { routeTasks } from "../orchestrator/route";
import { summarizeTasks } from "../orchestrator/summarize";
import { BudgetManager } from "../supervisor/budget";
import { MagnesiumError } from "../util/errors";
import { slugify, uuid } from "../util/ids";
import { runVerificationGate } from "../verification/gate";
import type { Verifier } from "../verification/verifier";
import type { LocalWorkerPool } from "../workers/pool";
import type { WorkerTask } from "../workers/worker";
import type { WorkspaceManager } from "../workers/worktree";

export interface EngineDeps {
  ledger: LedgerRepository;
  client: ModelClient;
  config: MagnesiumConfig;
  logger: Logger;
  workspace: WorkspaceManager;
  pool: LocalWorkerPool;
  verifier: Verifier;
}

/**
 * The run engine. Owns the plan -> schedule -> verify -> integrate -> done loop
 * and the resume path. Every state transition is a committed ledger write, so
 * the last commit is the checkpoint and a kill -9 is recoverable.
 */
export class MagnesiumEngine {
  private readonly ledger: LedgerRepository;
  private readonly client: ModelClient;
  private readonly config: MagnesiumConfig;
  private readonly logger: Logger;
  private readonly workspace: WorkspaceManager;
  private readonly pool: LocalWorkerPool;
  private readonly verifier: Verifier;
  private budgetTripped = false;

  constructor(deps: EngineDeps) {
    this.ledger = deps.ledger;
    this.client = deps.client;
    this.config = deps.config;
    this.logger = deps.logger;
    this.workspace = deps.workspace;
    this.pool = deps.pool;
    this.verifier = deps.verifier;
  }

  createRun(goal: string, workspaceDir: string): RunRow {
    const run = this.ledger.createRun({
      goal,
      workspaceDir,
      budgetUsdCap: this.config.budget.capUsd,
      modelOrchestrator: this.config.models.orchestrator,
      modelRouter: this.config.models.router,
    });
    this.ledger.appendEvent({ runId: run.id, type: "run_created", payload: { goal } });
    this.logger.info({ runId: run.id, goal }, "run created");
    return run;
  }

  async execute(runId: string): Promise<RunRow> {
    let run = this.ledger.getRun(runId);
    if (!run) throw new MagnesiumError(`run ${runId} not found`, "RUNTIME");
    const budget = new BudgetManager(
      this.ledger,
      runId,
      run.budgetUsdCap,
      this.config.budget.perWorkerCapUsd,
      this.logger,
    );
    this.budgetTripped = false;

    const existing = this.ledger.listTasks(runId);
    let baseCommit: string;
    if (run.status === "created" || existing.length === 0) {
      baseCommit = await this.plan(run, budget);
    } else {
      baseCommit = run.baseCommit ?? (await this.workspace.ensureRepo(run.workspaceDir));
      if (!run.baseCommit) this.ledger.setRunBaseCommit(runId, baseCommit);
      if (run.status !== "running") this.ledger.updateRunStatus(runId, "running");
    }
    run = this.ledger.getRun(runId) as RunRow;

    const inFlight = new Map<string, Promise<string>>();
    while (true) {
      if (this.budgetTripped || budget.isBreached()) break;

      const tasks = this.ledger.listTasks(runId);
      const deps = this.ledger.listDeps(runId);
      const { ready, blocked } = computeReady(tasks, deps);

      for (const id of blocked) {
        this.ledger.updateTask(id, { status: "blocked", error: "dependency failed" });
        this.ledger.appendEvent({ runId, taskId: id, type: "task_blocked" });
      }

      for (const id of ready) {
        if (inFlight.size >= this.config.concurrency) break;
        if (!budget.canDispatch()) break;
        if (inFlight.has(id)) continue;
        const workspaceDir = run.workspaceDir;
        inFlight.set(
          id,
          this.runTask(runId, workspaceDir, id, baseCommit, budget).then(() => id),
        );
      }

      const current = this.ledger.listTasks(runId);

      if (inFlight.size === 0) {
        const pending = current.filter((t) => t.status === "pending");
        // No work running and nothing left to schedule: proceed to integration.
        if (pending.length === 0) break;
        const { ready: readyNow } = computeReady(current, deps);
        if (readyNow.length === 0) {
          if (!budget.canDispatch()) {
            this.budgetTripped = true;
            break;
          }
          // Nothing ready, budget is fine, nothing running: genuine deadlock.
          for (const p of pending) {
            this.ledger.updateTask(p.id, { status: "blocked", error: "unreachable (deadlock)" });
            this.ledger.appendEvent({
              runId,
              taskId: p.id,
              type: "task_blocked",
              payload: { reason: "deadlock" },
            });
          }
          continue;
        }
        // Ready tasks exist but none could be dispatched (budget): pause.
        this.budgetTripped = true;
        break;
      }

      const finished = await Promise.race(inFlight.values());
      inFlight.delete(finished);
    }

    await Promise.allSettled([...inFlight.values()]);
    run = this.ledger.getRun(runId) as RunRow;
    if (this.budgetTripped || budget.isBreached()) {
      return this.pauseForBudget(runId, run, budget, inFlight);
    }
    return this.finishRun(runId, run, baseCommit, budget);
  }

  async resume(runId: string): Promise<RunRow> {
    const run = this.ledger.getRun(runId);
    if (!run) throw new MagnesiumError(`run ${runId} not found`, "RUNTIME");
    this.logger.info({ runId, status: run.status }, "resuming run");

    // Let the operator lift a budget pause by raising the configured cap.
    if (this.config.budget.capUsd > run.budgetUsdCap) {
      this.ledger.setRunBudgetCap(runId, this.config.budget.capUsd);
    }

    // Amendment 2: in-flight tasks are not resumed from partial state. Discard
    // the worktree (deterministic path) and reset the task to pending so it
    // re-dispatches cleanly.
    for (const t of this.ledger.listTasks(runId)) {
      if (IN_FLIGHT_TASK_STATUSES.includes(t.status)) {
        const path = t.worktreePath ?? this.workspace.worktreePathFor(runId, t.id);
        try {
          await this.workspace.removeWorktree(run.workspaceDir, path);
        } catch (err) {
          this.logger.debug({ err: (err as Error).message }, "worktree cleanup on resume");
        }
        this.ledger.updateTask(t.id, {
          status: "pending",
          worktreePath: null,
          branch: null,
          workerSessionId: null,
        });
        this.ledger.appendEvent({
          runId,
          taskId: t.id,
          type: "resumed_reset",
          payload: { from: t.status },
        });
      }
    }

    if (run.status !== "completed") this.ledger.updateRunStatus(runId, "running");
    this.ledger.appendEvent({ runId, type: "resumed", payload: { from: run.status } });
    return this.execute(runId);
  }

  private async plan(run: RunRow, budget: BudgetManager): Promise<string> {
    this.ledger.updateRunStatus(run.id, "planning");
    this.ledger.appendEvent({ runId: run.id, type: "planning_started" });

    const baseCommit = await this.workspace.ensureRepo(run.workspaceDir);
    this.ledger.setRunBaseCommit(run.id, baseCommit);

    const { dag, usage, costUsd, model } = await decompose(this.client, this.config, run.goal);
    this.ledger.recordLlmCall({
      runId: run.id,
      purpose: "decompose",
      model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheCreationTokens: usage.cacheCreationTokens,
      costUsd,
    });
    budget.record(costUsd);

    // Router-driven triage. Resilient: a missing or failed route falls back to
    // the raw decomposition so planning never hard-depends on the router.
    let planned = dag.tasks;
    try {
      const routed = await routeTasks(this.client, this.config, dag.tasks);
      this.ledger.recordLlmCall({
        runId: run.id,
        purpose: "route",
        model: routed.model,
        inputTokens: routed.usage.inputTokens,
        outputTokens: routed.usage.outputTokens,
        cacheReadTokens: routed.usage.cacheReadTokens,
        cacheCreationTokens: routed.usage.cacheCreationTokens,
        costUsd: routed.costUsd,
      });
      budget.record(routed.costUsd);
      const byId = new Map(routed.tasks.map((r) => [r.id, r]));
      planned = dag.tasks.map((t) => {
        const r = byId.get(t.id);
        return r ? { ...t, kind: r.kind, acceptanceCriteria: r.acceptanceCriteria } : t;
      });
      this.ledger.appendEvent({
        runId: run.id,
        type: "routed",
        payload: { warnings: routed.tasks.flatMap((r) => r.warnings) },
      });
    } catch (err) {
      this.logger.warn(
        { err: (err as Error).message },
        "router triage failed; using raw decomposition",
      );
    }

    const idMap = new Map<string, string>();
    this.ledger.transaction(() => {
      for (const t of planned) {
        const id = uuid();
        idMap.set(t.id, id);
        this.ledger.createTask({
          id,
          runId: run.id,
          slug: slugify(t.id),
          title: t.title,
          description: t.description,
          acceptanceCriteria: t.acceptanceCriteria,
          kind: t.kind,
          maxAttempts: this.config.worker.maxAttempts,
          model: t.suggestedModel ?? this.config.models.workerDefault,
        });
      }
      for (const t of planned) {
        for (const dep of t.dependsOn) {
          this.ledger.addDep(idMap.get(t.id) as string, idMap.get(dep) as string);
        }
      }
    });

    this.ledger.updateRunStatus(run.id, "running");
    this.ledger.appendEvent({
      runId: run.id,
      type: "planned",
      payload: { taskCount: dag.tasks.length },
    });
    this.checkpoint(run.id);
    this.logger.info({ runId: run.id, taskCount: dag.tasks.length }, "run planned");
    return baseCommit;
  }

  private async runTask(
    runId: string,
    workspaceDir: string,
    taskId: string,
    baseCommit: string,
    budget: BudgetManager,
  ): Promise<void> {
    const task = this.ledger.getTask(taskId);
    if (!task) return;
    const worktreePath = this.workspace.worktreePathFor(runId, taskId);
    const branch = this.workspace.branchFor(runId, taskId, task.slug);
    this.ledger.updateTask(taskId, { status: "dispatched", worktreePath, branch });
    this.ledger.appendEvent({ runId, taskId, type: "task_dispatched" });

    const model = task.model ?? this.config.models.workerDefault;
    const base: WorkerTask = {
      runId,
      taskId,
      slug: task.slug,
      title: task.title,
      description: task.description,
      acceptanceCriteria: task.acceptanceCriteria,
      kind: task.kind,
      model,
      worktreePath,
    };

    let attemptNo = 0;
    const gate = await runVerificationGate(base, task.maxAttempts, {
      shouldContinue: () => !this.budgetTripped,
      resumeOnRetry: this.config.worker.resumeOnRetry,
      prepareWorktree: async (attempt) => {
        attemptNo = attempt;
        // Clean re-run by default. With session-resume enabled, keep the
        // worktree across retries so the resumed session fixes in place.
        if (attempt === 1 || !this.config.worker.resumeOnRetry) {
          await this.workspace.createWorktree(workspaceDir, runId, taskId, task.slug, baseCommit);
        }
        this.ledger.updateTask(taskId, { attempt });
      },
      dispatch: async (wt) => {
        this.ledger.updateTask(taskId, { status: "running" });
        this.ledger.appendEvent({
          runId,
          taskId,
          type: "worker_started",
          payload: { attempt: attemptNo, model: wt.model },
        });
        const r = await this.pool.dispatch(wt);
        this.ledger.recordLlmCall({
          runId,
          taskId,
          purpose: "worker",
          model: wt.model,
          inputTokens: r.usage?.inputTokens ?? 0,
          outputTokens: r.usage?.outputTokens ?? 0,
          cacheReadTokens: r.usage?.cacheReadTokens ?? 0,
          cacheCreationTokens: r.usage?.cacheCreationTokens ?? 0,
          costUsd: r.costUsd,
        });
        if (r.sessionId) this.ledger.updateTask(taskId, { workerSessionId: r.sessionId });
        const { breached } = budget.record(r.costUsd);
        this.ledger.appendEvent({
          runId,
          taskId,
          type: "worker_done",
          payload: { ok: r.ok, costUsd: r.costUsd, attempt: attemptNo },
        });
        if (breached && !this.budgetTripped) {
          this.budgetTripped = true;
          this.logger.warn({ runId }, "budget tripped; SIGTERM in-flight workers");
          this.pool.abortAll();
        }
        return r;
      },
      verify: async (input) => {
        this.ledger.updateTask(taskId, { status: "verifying" });
        this.ledger.appendEvent({
          runId,
          taskId,
          type: "verify_started",
          payload: { attempt: attemptNo },
        });
        const verdict = await this.verifier.verify(input);
        // Critic verifications are model-backed; record their cost (Phase 2 gap close).
        if (verdict.usage && verdict.costUsd !== undefined) {
          this.ledger.recordLlmCall({
            runId,
            taskId,
            purpose: "critic",
            model: this.config.models.critic,
            inputTokens: verdict.usage.inputTokens,
            outputTokens: verdict.usage.outputTokens,
            cacheReadTokens: verdict.usage.cacheReadTokens,
            cacheCreationTokens: verdict.usage.cacheCreationTokens,
            costUsd: verdict.costUsd,
          });
          budget.record(verdict.costUsd);
        }
        this.ledger.recordArtifact({
          taskId,
          type: input.kind === "code" ? "test_report" : "critic_report",
          metadata: {
            pass: verdict.pass,
            reason: verdict.reason,
            report: verdict.report?.slice(0, 4_000),
          },
        });
        this.ledger.appendEvent({
          runId,
          taskId,
          type: verdict.pass ? "verify_passed" : "verify_failed",
          payload: { reason: verdict.reason, attempt: attemptNo },
        });
        return verdict;
      },
    });

    this.ledger.updateTask(taskId, { costUsd: gate.costUsd });
    if (gate.pass) {
      this.ledger.updateTask(taskId, {
        status: "verified",
        attempt: gate.attempts,
        resultSummary: gate.lastWorker?.summary ?? null,
      });
      this.ledger.appendEvent({
        runId,
        taskId,
        type: "task_verified",
        payload: { attempts: gate.attempts },
      });
    } else if (this.budgetTripped) {
      // Resumable: leave the task to be re-dispatched after resume.
      this.ledger.updateTask(taskId, { status: "pending" });
      this.ledger.appendEvent({ runId, taskId, type: "task_paused", payload: { reason: "budget" } });
    } else {
      this.ledger.updateTask(taskId, {
        status: "failed",
        attempt: gate.attempts,
        error: gate.failureReason ?? "verification failed",
      });
      this.ledger.appendEvent({
        runId,
        taskId,
        type: "task_failed",
        payload: { reason: gate.failureReason, attempts: gate.attempts },
      });
    }
    this.checkpoint(runId);
  }

  private async finishRun(
    runId: string,
    run: RunRow,
    baseCommit: string,
    budget: BudgetManager,
  ): Promise<RunRow> {
    const tasks = this.ledger.listTasks(runId);
    const verified = tasks.filter((t) => t.status === "verified");
    const anyFailed = tasks.some((t) => t.status === "failed" || t.status === "blocked");
    let conflicts = 0;

    if (verified.length > 0) {
      this.ledger.updateRunStatus(runId, "integrating");
      this.ledger.appendEvent({ runId, type: "integrating", payload: { count: verified.length } });
      const deps = this.ledger.listDeps(runId);
      const result = await integrateRun(
        this.workspace,
        run.workspaceDir,
        run,
        verified,
        deps,
        baseCommit,
        this.logger,
      );
      this.ledger.setRunIntegration(runId, result.integrationBranch, baseCommit);
      for (const id of result.merged) {
        this.ledger.updateTask(id, { status: "integrated" });
        this.ledger.appendEvent({ runId, taskId: id, type: "task_integrated" });
      }
      for (const c of result.conflicts) {
        conflicts++;
        this.ledger.appendEvent({
          runId,
          taskId: c.taskId,
          type: "integration_conflict",
          payload: { branch: c.branch },
        });
      }
    }

    let digest = compactRun(this.ledger.getRun(runId) as RunRow, this.ledger.listTasks(runId));
    // LLM context compaction: refine the per-task summaries the done decision
    // sees. Resilient: any failure leaves the deterministic digest in place.
    try {
      const terminal = this.ledger
        .listTasks(runId)
        .filter((t) => ["verified", "integrated", "failed", "blocked"].includes(t.status));
      if (terminal.length > 0) {
        const sum = await summarizeTasks(this.client, this.config, terminal);
        if (sum.costUsd > 0) {
          this.ledger.recordLlmCall({
            runId,
            purpose: "compact",
            model: sum.model,
            inputTokens: sum.usage.inputTokens,
            outputTokens: sum.usage.outputTokens,
            cacheReadTokens: sum.usage.cacheReadTokens,
            cacheCreationTokens: sum.usage.cacheCreationTokens,
            costUsd: sum.costUsd,
          });
          budget.record(sum.costUsd);
        }
        const byId = new Map(sum.summaries.map((s) => [s.id, s.summary]));
        digest = {
          ...digest,
          completed: digest.completed.map((c) => ({ ...c, summary: byId.get(c.id) ?? c.summary })),
          failed: digest.failed.map((f) => ({ ...f, summary: byId.get(f.id) ?? f.summary })),
        };
      }
    } catch (err) {
      this.logger.debug({ err: (err as Error).message }, "compaction summarize skipped");
    }
    let done = !anyFailed && conflicts === 0;
    let reason = done ? "all tasks integrated" : "some tasks failed or conflicted";
    try {
      const d = await decideDone(this.client, this.config, digest);
      this.ledger.recordLlmCall({
        runId,
        purpose: "integrate",
        model: d.model,
        inputTokens: d.usage.inputTokens,
        outputTokens: d.usage.outputTokens,
        cacheReadTokens: d.usage.cacheReadTokens,
        cacheCreationTokens: d.usage.cacheCreationTokens,
        costUsd: d.costUsd,
      });
      budget.record(d.costUsd);
      done = d.decision.done && !anyFailed && conflicts === 0;
      reason = d.decision.reason;
    } catch (err) {
      this.logger.warn(
        { err: (err as Error).message },
        "done decision failed; using deterministic fallback",
      );
    }

    const status = done ? "completed" : "failed";
    this.ledger.updateRunStatus(runId, status);
    this.ledger.appendEvent({ runId, type: done ? "run_completed" : "run_failed", payload: { reason } });
    this.checkpoint(runId);
    this.logger.info({ runId, status, spentUsd: budget.spent() }, "run finished");
    return this.ledger.getRun(runId) as RunRow;
  }

  private async pauseForBudget(
    runId: string,
    run: RunRow,
    budget: BudgetManager,
    inFlight: Map<string, Promise<string>>,
  ): Promise<RunRow> {
    this.pool.abortAll();
    await Promise.allSettled([...inFlight.values()]);
    this.ledger.updateRunStatus(runId, "paused");
    this.ledger.appendEvent({
      runId,
      type: "budget_paused",
      payload: { spentUsd: budget.spent(), capUsd: run.budgetUsdCap },
    });
    this.checkpoint(runId);
    this.logger.warn(
      { runId, spentUsd: budget.spent(), capUsd: run.budgetUsdCap },
      "run paused: budget cap reached. raise MAGNESIUM_BUDGET_USD and resume",
    );
    return this.ledger.getRun(runId) as RunRow;
  }

  private checkpoint(runId: string): void {
    const run = this.ledger.getRun(runId);
    if (!run) return;
    const digest = compactRun(run, this.ledger.listTasks(runId)) as unknown as Record<
      string,
      unknown
    >;
    this.ledger.saveCheckpoint(runId, digest);
  }
}
