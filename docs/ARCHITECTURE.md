# Magnesium Architecture

> Status: design proposal, awaiting approval. No implementation code is written yet.

## 1. Mission and the local / remote boundary

Magnesium is a self-hosted multi-agent orchestration harness. Its job is to make a
single remote, closed model (Claude Opus 4.8) behave like a long-running,
self-correcting, multi-agent system through scaffolding, not through any change to
the model.

The hard boundary:

| Concern | Where it runs | Why |
|---|---|---|
| Model inference (reasoning, code generation) | Remote (Anthropic API, or a headless `claude` subprocess that calls the API) | Opus 4.8 is closed. We cannot run or modify its weights. |
| Orchestration, scheduling, DAG logic | Local | This is the novel value. We own it. |
| Durable state, ledger, checkpoints | Local (SQLite file) | Survives process death. |
| Verification, test execution | Local | Blocking gate before integration. |
| Supervision, budget, confirmations | Local | Control plane. |

Everything except token generation is local. The only network calls are model
inference and, later, optional remote control (Telegram) and worker discovery (AIP).

## 2. Architectural stance: reuse Claude Code, do not rebuild it

Claude Code already provides a production-grade agentic coding loop: tool use,
in-session subagents, file editing, test running, permission control. Magnesium does
not reimplement any of that. Instead:

- **Workers are headless Claude Code instances** (`claude -p`). Each worker gets the
  full coding agent for free. We only scope, dispatch, isolate, and verify them.
- **Magnesium's novel layer sits on top**: cross-session orchestration, a durable
  ledger, a blocking verification gate, context compaction, and a supervisor.

We split model usage by role:

| Role | Transport | Model | Rationale |
|---|---|---|---|
| Orchestrator (decompose, integrate, decide done) | Direct `@anthropic-ai/sdk` Messages API, extended thinking, structured output | `claude-opus-4-8` | We need tight control of the prompt, the thinking budget, and a validated JSON schema for the task DAG. |
| Router / triage / classify | Direct SDK | `claude-haiku-4-5` | Cheap, fast, high-volume decisions. |
| Critic / generic verifier | Direct SDK | `claude-haiku-4-5` (escalates to Opus on low confidence) | Judges an artifact against acceptance criteria. |
| Worker (do the task) | Subprocess `claude -p --output-format stream-json` | tier per task (default Sonnet for code, configurable) | Reuse the Claude Code coding loop, subagents, and tool use. |

The orchestrator is a structured Opus call, not a Claude Code session, because we want
deterministic, schema-validated decomposition output and full control of the loop.
Workers are Claude Code sessions, because the agentic coding loop is exactly what
Claude Code already does best.

## 3. Component map

```
                         magnesium run "<goal>"
                                  |
                                  v
                       +---------------------+
                       |     RuntimeEngine    |  run / resume loop
                       +----------+----------+
                                  |
        +-------------------------+--------------------------+
        |             |             |            |           |
        v             v             v            v           v
  Orchestrator   Scheduler     WorkerPool    Verifier    Supervisor
  (Opus+think)   (topo+conc.)  (claude -p)   (gate)      (budget/health/
        |             |          per worktree   |          confirm)
        |             |             |           |           |
        +------+------+------+------+-----------+-----------+
                                  |
                                  v
                        LedgerRepository (SQLite)
                   runs / tasks / deps / artifacts /
                   events / llm_calls / checkpoints
```

### 3.1 RuntimeEngine (`src/runtime/`)
The top-level loop. Drives a run through its lifecycle and is the single owner of the
resume logic. Pseudocode:

```
plan:      if run has no tasks -> Orchestrator.decompose(goal) -> persist DAG
schedule:  loop while ready tasks exist and run is active:
             pick ready tasks (deps satisfied), bounded by concurrency
             for each: dispatch worker in fresh worktree
           wait for any worker to finish
verify:    on worker done -> Verifier.gate(task) (blocking)
             pass -> task VERIFIED
             fail and attempts left -> re-dispatch with failure context
             fail and no attempts -> task FAILED
integrate: when all tasks terminal -> Orchestrator.integrate(verified results)
done:      Orchestrator.decideDone -> run COMPLETED / FAILED
```

Every transition is a committed ledger write before the next action. The DB after each
commit is the checkpoint. There is no separate checkpoint file format for core state.

### 3.2 Orchestrator (`src/orchestrator/`)
- `decompose.ts`: goal to a task DAG via Opus with extended thinking, output validated
  against a zod schema. The model returns tasks with id, title, description,
  acceptance criteria, kind (`code` | `generic` | `research`), and `dependsOn` edges.
- `dag.ts`: validates the DAG is acyclic, computes the ready-set (tasks whose deps are
  all `VERIFIED`/`INTEGRATED`), topological ordering.
- `scheduler.ts`: concurrency-bounded dispatch over the ready-set using `p-queue`.
- `integrate.ts`: merges verified worktrees into the run's integration branch,
  sequentially, surfacing conflicts as a human-confirm event rather than auto-resolving.
- `compaction.ts`: once a subtree completes, summarizes its task results into a compact
  digest, persisted as a checkpoint and re-injected into later orchestrator prompts so
  the orchestrator window stays bounded over long runs.
- `done.ts`: decides whether the run satisfied the goal.

### 3.3 Workers (`src/workers/`)
- `worker.ts`: `WorkerAdapter` interface and `WorkerResult` type. The interface is the
  seam for distributed discovery later (a remote worker keyed by `did:aip:{wallet}:{agent_id}`).
- `container-worker.ts`: the Phase 1 default. Runs a headless `claude -p` inside an
  isolated container (OrbStack by default, any Docker-compatible runtime) with the task
  worktree bind-mounted at `/work` as the only writable host path. A worker cannot write
  outside its worktree, push, or force-push. `local-worker.ts` is a documented fallback
  that runs `claude -p` directly on the host. Both build the same invocation via
  `claude-invocation.ts`:
  - `--bare`, which forces `ANTHROPIC_API_KEY` auth: metered API billing for both the
    orchestrator and workers (OAuth and the keychain are never read). There is no
    keychain inside the container, so this is also the only auth path there.
  - `--output-format stream-json` (parse the event stream, capture the final `result`
    event with `total_cost_usd`, `usage`, `session_id`, `num_turns`)
  - `--model <tier>`
  - `--permission-mode acceptEdits` (never bypasses destructive ops) plus a restrictive
    `--allowedTools` allowlist (no git, no push, no force-push, no destructive network)
  - `--max-budget-usd <perWorkerCap>` as a second line of cost defense
  - the scoped task prompt (title, description, acceptance criteria, and on retry, the
    prior failure output)
- `worktree.ts`: `WorkspaceManager`. Ensures the target git repo exists, creates one
  `git worktree` per task off a known base commit on a per-task branch
  (`magnesium/run-<run>/task-<task>`), and removes worktrees on integration or reset.
- `pool.ts`: `LocalWorkerPool`, a `Dispatcher` implementation over `p-queue` with
  configurable concurrency (default 8), rate-limit-aware backoff, and PID tracking so
  the supervisor can kill a hung worker.

### 3.4 Verification (`src/verification/`)
Blocking. A task is never integrated before it passes.
- `verifier.ts`: `Verifier` interface returning a `Verdict { pass, reason, report }`.
- `code-test-verifier.ts`: for `kind: code`, runs the repo's test command (configurable,
  default `pnpm test` or a task-declared command) inside the worktree as a subprocess
  with a timeout, captures output, pass/fail on exit code.
- `critic-verifier.ts`: for `kind: generic` / `research`, an LLM judge (Haiku, escalating
  to Opus when confidence is low) scores the artifact against the task's acceptance
  criteria and returns a structured verdict.
- `gate.ts`: orchestrates verify plus capped retry. On failure with attempts remaining,
  the worker is re-dispatched with the failure report appended to its prompt.

Sandboxing note (honest scope): in Phase 1 the worker runs inside a container, but the
verifier runs the test command on the host inside the worktree (process isolation plus
worktree plus subprocess timeout). Running test execution itself inside a container or
VM jail is a hardening seam.

### 3.5 Supervisor / control plane (`src/supervisor/`)
- `budget.ts`: `BudgetManager`. Sums `total_cost_usd` from workers plus computed cost of
  direct orchestrator/router/critic calls (usage times the configured rate table).
  Enforces a hard cap: before each dispatch it checks projected spend; on breach it sets
  the run to `PAUSED`, persists, and stops dispatching. Resume requires raising the cap.
- `health.ts`: worker timeout detection. On timeout it kills the worker PID, increments
  the attempt, and re-dispatches up to `maxAttempts`.
- `confirmation.ts`: `ConfirmationGate`. Any irreversible action (`git push`, force push,
  `rm -rf`, anything touching a real remote) must pass through `confirm()`. Phase 1
  implementation prompts on the CLI. This is also the seam for Telegram approval.
- `control-surface.ts`: `ControlSurface` interface (status, pause, resume, confirm).
  Phase 1 implementation is the CLI plus the `status` command. Telegram is a future
  implementation of the same interface.

Phase 1 keeps the supervisor in-process (invoked by the engine loop), not a separate
daemon, but the boundaries are drawn so it can be extracted into a daemon later.

## 4. Data model (the ledger)

SQLite, single file, WAL mode. Run-state transitions use `synchronous=FULL` to guarantee
durability across `kill -9` (the explicit Phase 1 requirement). Accessed only through the
`LedgerRepository` interface so it can later be swapped for Postgres or an external
WienerLog service.

```sql
-- A single orchestration run.
CREATE TABLE runs (
  id              TEXT PRIMARY KEY,         -- uuid
  goal            TEXT NOT NULL,
  status          TEXT NOT NULL,            -- created|planning|running|integrating|completed|failed|aborted|paused
  workspace_dir   TEXT NOT NULL,            -- target git repo
  base_commit     TEXT,
  integration_branch TEXT,
  budget_usd_cap  REAL NOT NULL,
  cost_usd_spent  REAL NOT NULL DEFAULT 0,
  model_orchestrator TEXT NOT NULL,
  model_router    TEXT NOT NULL,
  metadata        TEXT,                     -- json
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

-- A node in the task DAG.
CREATE TABLE tasks (
  id              TEXT PRIMARY KEY,
  run_id          TEXT NOT NULL REFERENCES runs(id),
  parent_id       TEXT REFERENCES tasks(id),   -- subtree grouping for compaction
  title           TEXT NOT NULL,
  description     TEXT NOT NULL,
  acceptance_criteria TEXT NOT NULL,           -- json string[]
  kind            TEXT NOT NULL,               -- code|generic|research
  status          TEXT NOT NULL,               -- pending|ready|dispatched|running|verifying|verified|integrated|failed|blocked|cancelled
  attempt         INTEGER NOT NULL DEFAULT 0,
  max_attempts    INTEGER NOT NULL DEFAULT 2,
  model           TEXT,                        -- worker model tier
  worktree_path   TEXT,
  branch          TEXT,
  worker_session_id TEXT,                      -- claude -p session id, enables session resume later
  cost_usd        REAL NOT NULL DEFAULT 0,
  result_summary  TEXT,
  error           TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

-- DAG edges. task depends_on depends_on_id.
CREATE TABLE task_deps (
  task_id         TEXT NOT NULL REFERENCES tasks(id),
  depends_on_id   TEXT NOT NULL REFERENCES tasks(id),
  PRIMARY KEY (task_id, depends_on_id)
);

-- Outputs produced by a task.
CREATE TABLE artifacts (
  id              TEXT PRIMARY KEY,
  task_id         TEXT NOT NULL REFERENCES tasks(id),
  type            TEXT NOT NULL,               -- diff|file|test_report|critic_report|log
  path            TEXT,
  sha256          TEXT,
  metadata        TEXT,                        -- json
  created_at      TEXT NOT NULL
);

-- Append-only audit trail. The basis for status reconstruction and debugging.
CREATE TABLE events (
  id              TEXT PRIMARY KEY,
  run_id          TEXT NOT NULL REFERENCES runs(id),
  task_id         TEXT REFERENCES tasks(id),
  seq             INTEGER NOT NULL,            -- monotonic per run
  type            TEXT NOT NULL,               -- decomposed|dispatched|worker_done|verified|failed|integrated|budget_paused|confirm_requested|...
  payload         TEXT,                        -- json
  created_at      TEXT NOT NULL
);

-- Per-call cost ledger feeding the BudgetManager.
CREATE TABLE llm_calls (
  id              TEXT PRIMARY KEY,
  run_id          TEXT NOT NULL REFERENCES runs(id),
  task_id         TEXT REFERENCES tasks(id),
  purpose         TEXT NOT NULL,               -- decompose|route|critic|compact|integrate|worker
  model           TEXT NOT NULL,
  input_tokens    INTEGER NOT NULL DEFAULT 0,
  output_tokens   INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd        REAL NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL
);

-- Compacted orchestrator working memory, for resume and bounded context.
CREATE TABLE checkpoints (
  id              TEXT PRIMARY KEY,
  run_id          TEXT NOT NULL REFERENCES runs(id),
  seq             INTEGER NOT NULL,
  digest          TEXT NOT NULL,               -- compacted state json
  created_at      TEXT NOT NULL
);

CREATE TABLE schema_meta ( version INTEGER NOT NULL );
```

### 4.1 Task state machine

```
pending --(deps satisfied)--> ready --(dispatch)--> dispatched --> running
running --> verifying --(pass)--> verified --(merge)--> integrated
verifying --(fail, attempts left)--> ready        (re-dispatch w/ failure context)
verifying --(fail, no attempts)--> failed
running   --(timeout/crash)--> ready              (supervisor re-dispatch)
ready/pending --(dep failed)--> blocked
any non-terminal --(run abort)--> cancelled
```

Terminal states: `integrated`, `failed`, `blocked`, `cancelled`.

### 4.2 Resume semantics (the kill -9 guarantee)

On `magnesium resume <run_id>`:
1. Load the run and all tasks from the ledger.
2. Any task left in `dispatched`, `running`, or `verifying` at crash time is treated as
   in-flight-unknown (no worker is actually alive after a process death). Reset it to
   `ready`.
3. Reconcile worktrees: remove any stale worktree registered for a reset task, so the
   re-dispatch starts clean. Re-dispatch is therefore idempotent at the task level.
4. Tasks in `verified` / `integrated` / `failed` / `blocked` are kept as-is.
5. Re-enter the engine loop from `schedule`.

Idempotency is at the task level: a fresh worktree per dispatch means re-running a task
never corrupts prior state. A later optimization is to resume the worker's own Claude
Code session via `--resume <worker_session_id>` instead of restarting the task.

## 5. Concurrency, rate limits, retries

- `p-queue` with `concurrency = config.concurrency` (default 3) bounds parallel workers.
- Each `claude -p` worker is itself a multi-call agent, so a few workers can mean many
  concurrent API calls. The real ceiling depends on the Anthropic rate tier. Default 3
  is conservative for Phase 1 and configurable; revisit after observing 429s.
- A shared backoff utility (exponential plus jitter) wraps both direct SDK calls and
  worker spawns. On HTTP 429 the queue pauses and retries. `--fallback-model` is set on
  workers so an overloaded primary degrades instead of failing.

## 6. Failure modes and responses

| Failure | Detection | Response |
|---|---|---|
| `kill -9` mid-run | Process death | `resume` rebuilds from ledger, resets in-flight tasks to `ready`, re-dispatches idempotently |
| Worker hangs | Timeout in `health.ts` | Kill PID, increment attempt, re-dispatch up to `maxAttempts` |
| Worker produces wrong / partial output | Verification gate (tests or critic fail) | Re-dispatch with failure report; after cap, mark `failed` |
| Flaky verification | Repeated near-pass | Cap retries, mark `failed`, surface; quarantine seam |
| Budget exceeded | `BudgetManager` projection before dispatch | Set run `paused`, persist, stop dispatch; resume needs higher cap |
| Worktree leak / orphan | Reconciliation on resume | Remove orphan worktrees not tied to a live task |
| DB write torn by crash | WAL plus `synchronous=FULL` on state transitions | Atomic transactions, last committed state is consistent |
| Rate limit (429) | SDK / worker error | Backoff plus jitter, pause queue, `--fallback-model` |
| Cyclic or malformed DAG | `dag.ts` validation after decompose | Reject, re-prompt orchestrator with the validation error |
| Merge conflict at integration | `git merge` non-zero | Halt, raise a confirm event, do not auto-resolve destructively |
| Secret leakage | Pino redaction, env-only config | Keys never written to ledger, logs, or worktrees |

## 7. Configuration

Defaults live in `src/config/defaults.ts`, overlaid with environment variables and
validated by a zod schema. Key fields:

| Field | Default | Note |
|---|---|---|
| `models.orchestrator` | `claude-opus-4-8` | 1M-context variant available for very long runs |
| `models.router` | `claude-haiku-4-5` | triage / classify |
| `models.workerDefault` | `claude-sonnet-4-6` | per-task override allowed |
| `budget.capUsd` | `5.00` | hard cap, run pauses on breach |
| `budget.perWorkerCapUsd` | `1.00` | passed to `claude -p --max-budget-usd` |
| `concurrency` | `3` | conservative for Phase 1; revisit after 429s |
| `worker.permissionMode` | `acceptEdits` | never bypasses destructive ops |
| `worker.maxAttempts` | `2` | verification retry cap |
| `worker.timeoutMs` | `600000` | hang detection |
| `container.enabled` | `true` | run workers in OrbStack/Docker containers |
| `container.runtime` | `orbstack` | `orbstack` or `docker` (both via the `docker` CLI) |
| `pricing` | placeholder table | VERIFY against current Anthropic pricing; used only for direct SDK calls, workers self-report `total_cost_usd` |
| `paths.ledger` | `.magnesium/ledger.db` | |
| `paths.worktrees` | `.magnesium/worktrees` | |

The `pricing` table is the one place fabricated numbers would be dangerous, so it ships
as a clearly-marked placeholder for the operator to confirm. Worker cost does not depend
on it because Claude Code reports `total_cost_usd` directly.

## 8. Forward seams (designed, not implemented in Phase 1)

- **Distributed worker discovery.** The `WorkerAdapter` / `Dispatcher` interfaces let the
  `LocalWorkerPool` be replaced by a registry that resolves workers by
  `did:aip:{wallet}:{agent_id}`. Dispatch stays the same shape; only resolution changes.
- **Telegram control surface.** `ControlSurface` and `ConfirmationGate` are interfaces.
  A Telegram bot is a future implementation that answers status and approves confirms.
- **Postgres / WienerLog ledger.** `LedgerRepository` hides the storage engine.
- **Worker session resume.** `worker_session_id` is persisted now so a future resume can
  continue the worker's own Claude Code session rather than restarting the task.
- **Container-isolated verification.** `Verifier` can later run tests in a container.

## 9. Phase 1 definition of done (vertical slice)

- `magnesium run "<goal>"` decomposes into a DAG, dispatches at least two workers in
  parallel (each a `claude -p` in its own worktree), a blocking verifier runs tests, and
  verified results integrate.
- Every step is checkpointed. `magnesium resume <run_id>` completes correctly after a
  `kill -9` mid-run. `magnesium status` shows the live DAG.
- Hard token / cost budget enforced. Structured JSON logs. Unit tests cover orchestrator
  decomposition, ledger persistence and resume, and the verifier gate. README with setup
  and usage.
- Clean unimplemented seams left for distributed discovery and the Telegram surface.

The canonical Phase 1 smoke goal operates on an ephemeral sandbox repo so the demo is
hermetic and reproducible, and decomposes into at least two independent tested code tasks.
