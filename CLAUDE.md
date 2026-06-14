# CLAUDE.md - Magnesium

Project memory for Claude Code working in this repo. Read this first.

## Mission

Magnesium is a self-hosted multi-agent orchestration harness. It makes one remote,
closed model (Claude Opus 4.8) behave like a long-running, self-correcting, multi-agent
system through scaffolding, not through model changes. We approximate Mythos-class
autonomy with orchestration, durable state, verification, and supervision built around
the model.

## The local / remote boundary (the core invariant)

Opus 4.8 is closed. We cannot run or modify its weights. Everything except token
generation runs locally. The only outbound network calls are:
1. Model inference (Anthropic API, or a headless `claude` subprocess that calls it).
2. Later, optional: Telegram control and AIP worker discovery.

If a design idea requires changing or hosting the model, it is out of scope by
definition. Magnesium is the harness around the model.

## Architectural stance: reuse Claude Code, do not rebuild it

- **Workers are headless Claude Code instances** (`claude -p`). They get the full
  agentic coding loop, tool use, and subagents for free. Do not reimplement those.
- **Magnesium's value is the layer on top**: orchestration (goal to task DAG),
  a durable ledger, a blocking verification gate, context compaction, and a supervisor.

Model usage by role:
- Orchestrator (decompose / integrate / decide done): direct `@anthropic-ai/sdk` call,
  `claude-opus-4-8`, extended thinking, schema-validated structured output.
- Router / triage / critic: direct SDK, `claude-haiku-4-5`.
- Worker (does the task): subprocess `claude -p --output-format stream-json`.

## Invariants (do not violate)

1. Every run, task, status, artifact, decision, and LLM call is persisted to the ledger
   before the next action. The committed DB is the checkpoint.
2. `resume` after `kill -9` must complete the run correctly. In-flight tasks reset to
   `ready` and re-dispatch idempotently in fresh worktrees.
3. Verification is blocking. A task is never integrated before its verdict passes.
4. The budget cap is hard. On projected breach the run pauses and persists.
5. Irreversible actions (`git push`, force push, `rm -rf`, touching a real remote) go
   through `ConfirmationGate.confirm()`. Never bypass it.
6. No secrets in code, ledger, logs, or worktrees. Env only. Pino redacts keys.
7. The ledger is only touched through `LedgerRepository`. No raw SQL elsewhere.
8. Workers run in isolated git worktrees, each inside its own container. No two workers
   share a working tree. Worktree paths are deterministic from (runId, taskId) so resume
   can discard a stale worktree and re-dispatch cleanly. On resume, in-flight tasks are
   never resumed from partial state: the worktree is discarded and the task re-runs clean.

## Conventions

- TypeScript, Node 22+, strict mode. pnpm. ESM.
- Validation with zod at every boundary (config, LLM output, ledger row to type).
- Structured logging with pino. JSON logs.
- Tests with vitest. Cover orchestrator decomposition, ledger persistence/resume, and
  the verifier gate at minimum.
- Conventional commits. No attribution footer (disabled globally).
- No em dash anywhere: code, comments, docs, commits, UI copy. Use hyphens or rewrite.
- Entire project in English: code, comments, docs, commits.

## Model IDs (confirmed against the live environment, not the stale skill table)

- Opus 4.8: `claude-opus-4-8` (1M-context variant `claude-opus-4-8[1m]` for long runs)
- Sonnet 4.6: `claude-sonnet-4-6`
- Haiku 4.5: `claude-haiku-4-5` (pinned `claude-haiku-4-5-20251001`)

## Worker transport (the `claude -p` contract)

Workers run inside an isolated container (OrbStack by default) with the task worktree
bind-mounted at `/work` as the only writable host path. The `claude -p` invocation uses:
`--bare` (forces `ANTHROPIC_API_KEY` auth, so orchestrator and workers share one metered
API billing model; subscription OAuth is a documented fallback only), `--output-format
stream-json`, `--model <tier>`, `--permission-mode acceptEdits` (never bypasses
destructive ops), a restrictive `--allowedTools` allowlist (no git, no push, no
force-push, no destructive network), `--max-budget-usd <perWorkerCap>`. Capture the final
`result` event for `total_cost_usd`, `usage`, `session_id`, `num_turns`. Workers
self-report cost, so the config pricing table is only for direct SDK calls.

`local-worker.ts` runs `claude -p` directly on the host (still `--bare`) and is the
fallback when no container runtime is available.

## Commands (Phase 1 target)

```
pnpm install
pnpm build              # tsc
pnpm test               # vitest
pnpm lint               # eslint
magnesium run "<goal>"  # decompose, dispatch, verify, integrate
magnesium resume <id>   # continue after crash
magnesium status [<id>] # show live DAG
```

## Forward seams (leave clean, do not implement in Phase 1)

- Distributed worker discovery via `did:aip:{wallet}:{agent_id}` behind `WorkerAdapter`.
- Telegram control surface behind `ControlSurface` / `ConfirmationGate`.
- Postgres / WienerLog ledger behind `LedgerRepository`.
- Worker session resume via persisted `worker_session_id`.

## Repo

`wienerlabs/magnesium`, private. First commit only after Phase 1 is complete and tests
pass. Create the repo with
`gh repo create wienerlabs/magnesium --private --source=. --remote=origin`.

See `docs/ARCHITECTURE.md` for the full design, data model, and failure-mode table.
