# Magnesium

<img width="1080" height="1080" alt="029e8ca97faa8ec0ea0e295b86551cd3 (1)" src="https://github.com/user-attachments/assets/56077175-feb9-463d-8ec4-63882afcedd5" />

A self-hosted multi-agent orchestration harness that makes one remote, closed
model (Claude Opus 4.8) behave like a long-running, self-correcting, multi-agent
system through scaffolding, not model changes.

Everything except token generation runs locally. Workers are headless Claude Code
instances; Magnesium is the layer on top: orchestration, a durable ledger, a
blocking verification gate, and a supervisor.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full design and
[CLAUDE.md](CLAUDE.md) for project memory and invariants.

## How it works

```
magnesium run "<goal>"
   |
   v
orchestrator (Opus 4.8 + extended thinking)  -> task DAG
   |
   v
scheduler (bounded concurrency)  -> dispatch workers in parallel
   |                                  each: headless claude -p in a container,
   |                                  scoped to its own git worktree
   v
verification gate (blocking)     -> run tests / critic, retry on failure
   |
   v
integration                      -> merge verified branches
   |
   v
done decision (Opus 4.8)         -> completed / failed
```

Every step is checkpointed to a local SQLite ledger, so a run survives process
death. `magnesium resume <id>` continues after a `kill -9`.

## Requirements

- Node 22+ and pnpm
- `ANTHROPIC_API_KEY` (Phase 1 runs the orchestrator and workers on metered API
  billing; workers use `claude -p --bare`, which forces API auth)
- A container runtime for worker isolation: OrbStack (recommended) or Docker
- git

## Setup

```bash
pnpm install
cp .env.example .env   # then set ANTHROPIC_API_KEY
pnpm worker:build      # builds the worker container image (needs OrbStack/Docker running)
```

## Usage

```bash
# Decompose a goal, dispatch workers, verify, and integrate.
pnpm dev run "build a tested TypeScript slugify utility"
# (or, after `pnpm build`, the installed `magnesium` binary)

# Show all runs, or the live DAG for one run.
pnpm dev status
pnpm dev status <runId>

# Continue a run after a crash or a budget pause.
pnpm dev resume <runId>

# Observability.
pnpm dev events <runId> --format plain   # event stream (plain or json)
pnpm dev cost <runId>                     # cost breakdown per purpose and model
pnpm dev dag <runId>                      # render the task DAG
```

### End-to-end demo

```bash
pnpm tsx scripts/demo.ts
```

Runs a hermetic, dependency-free goal in a fresh sandbox repo (workers write ESM
modules tested with `node --test`). Requires `ANTHROPIC_API_KEY` and a running
container runtime.

## Configuration

Defaults live in [src/config/defaults.ts](src/config/defaults.ts). Operational
values are overridable via environment variables (see `.env.example`):

| Variable | Meaning |
|---|---|
| `ANTHROPIC_API_KEY` | Required. API billing for orchestrator and workers. |
| `MAGNESIUM_BUDGET_USD` | Hard cost cap per run. |
| `MAGNESIUM_CONCURRENCY` | Max parallel workers (default 3). |
| `MAGNESIUM_WORKER_IMAGE` | Worker container image tag. |
| `MAGNESIUM_CONTAINER_RUNTIME` | `orbstack` or `docker`. |

Price rates used for direct-call cost accounting are in `src/config/defaults.ts`,
marked `VERIFY`. Confirm them against current Anthropic pricing. Worker cost does
not depend on them: Claude Code reports `total_cost_usd` directly.

## Development

```bash
pnpm typecheck   # tsc --noEmit
pnpm test        # vitest (no API key or container needed; uses stubs)
pnpm lint        # eslint
pnpm build       # tsup -> dist/magnesium.js
```

The unit tests cover orchestrator decomposition, ledger persistence and resume
(including a kill -9 mid-worker clean re-run), the verification gate, budget
enforcement, worker invocation, and all Phase 2 capabilities. They run fully
offline with stubs.

## Phase 2 capabilities

Built on the Phase 1 vertical slice, all unit-tested offline:

- Telegram control surface (`TelegramControlSurface`, `TelegramConfirmationGate`),
  transport-abstracted with the grammY adapter isolated. Live `serve` wiring is a
  Phase 3 daemon item; the core is exported and tested.
- AIP distributed worker dispatch: `did:aip:{wallet}:{agent_id}` parsing, a
  `WorkerRegistry`, and an `AipDispatcher` with a loopback fallback.
- Observability: `magnesium events`, `magnesium cost`, `magnesium dag`, plus
  per-purpose and per-model cost reporting.
- LLM context compaction with a deterministic fallback, wired into the done
  decision.
- Critic verification cost is recorded to the ledger (Phase 1 gap closed).
- Router-driven task triage during planning (the Haiku router validates kinds and
  sharpens acceptance criteria; resilient with a raw-decomposition fallback).
- Worker session resume on retry (`--resume`), opt-in via `worker.resumeOnRetry`
  and gated to environments with a persistent session store.

## Guardrails

- Workers run in isolated containers, scoped to a single worktree. They cannot
  write outside it, push, or force-push.
- The budget cap is hard. On a breach the engine SIGTERMs in-flight workers and
  checkpoints a resumable paused state.
- Irreversible actions go through a confirmation gate. No secrets in code, the
  ledger, logs, or worktrees.

## Forward seams (Phase 3 and beyond)

- A supervisor daemon (`magnesium serve`) so the Telegram surface can pause and
  resume an in-flight run, not just read its state.
- A Postgres or WienerLog ledger behind `LedgerRepository`.
- A real remote AIP resolver (the dispatch seam and DID layer are implemented;
  resolution is currently loopback).
- Container-isolated test execution (the worker is containerized; the verifier
  still runs tests on the host).
