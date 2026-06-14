import type { LedgerRepository } from "../../ledger/repository";
import type { EventRow, RunRow, TaskRow, TaskStatus } from "../../ledger/types";
import type { Logger } from "../../logging/logger";
import { shortId } from "../../util/ids";
import type { ControlSurface, RunStatusView } from "../control-surface";
import { parseCommand, type TelegramCommand, type TelegramTransport } from "./transport";

/**
 * Routes pause/resume requests from chat to the running supervisor. The engine
 * implements this; tests inject a recording double. Kept narrow on purpose so
 * the surface never reaches into engine internals.
 */
export interface RunSupervisor {
  /** Request the run pause at the next safe point. */
  requestPause(runId: string): void | Promise<void>;
  /** Request a paused run resume. */
  requestResume(runId: string): void | Promise<void>;
}

export interface TelegramControlSurfaceOptions {
  ledger: LedgerRepository;
  transport: TelegramTransport;
  supervisor: RunSupervisor;
  logger: Logger;
  /**
   * Default run to target when a command omits a run id. Usually the single
   * active run. When unset, run-scoped commands require an explicit id.
   */
  defaultRunId?: string;
}

const HELP_TEXT = [
  "Magnesium control surface",
  "",
  "/status [runId]  - run status, task counts, recent events",
  "/runs            - list all runs",
  "/cost [runId]    - current spend and remaining budget",
  "/pause [runId]   - request the run pause",
  "/resume [runId]  - resume a paused run",
  "/help            - this message",
].join("\n");

/**
 * Telegram-backed ControlSurface. Reads run status straight from the ledger
 * (same contract as LedgerControlSurface) and additionally handles chat commands
 * for status, cost, pause and resume. No grammy dependency: all I/O goes through
 * the injected TelegramTransport.
 */
export class TelegramControlSurface implements ControlSurface {
  private readonly ledger: LedgerRepository;
  private readonly transport: TelegramTransport;
  private readonly supervisor: RunSupervisor;
  private readonly logger: Logger;
  private readonly defaultRunId?: string;
  private unsubscribe?: () => void;

  constructor(opts: TelegramControlSurfaceOptions) {
    this.ledger = opts.ledger;
    this.transport = opts.transport;
    this.supervisor = opts.supervisor;
    this.logger = opts.logger;
    this.defaultRunId = opts.defaultRunId;
  }

  // ControlSurface contract -------------------------------------------------

  status(runId: string): RunStatusView | null {
    const run = this.ledger.getRun(runId);
    if (!run) return null;
    const events = this.ledger.listEvents(runId);
    return {
      run,
      tasks: this.ledger.listTasks(runId),
      deps: this.ledger.listDeps(runId),
      recentEvents: events.slice(-20),
    };
  }

  listRuns(): RunRow[] {
    return this.ledger.listRuns();
  }

  // Chat wiring -------------------------------------------------------------

  /** Begin listening for chat commands. Idempotent; safe to call once. */
  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.transport.onCommand((command) => this.handleCommand(command));
  }

  /** Stop listening. */
  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  /**
   * Dispatch a single chat command. Exposed (and used by start) so tests can
   * drive it directly. Errors are caught and surfaced to chat rather than thrown
   * into the transport's event loop.
   */
  async handleCommand(command: TelegramCommand): Promise<void> {
    try {
      switch (command.name) {
        case "status":
          await this.onStatus(command);
          return;
        case "runs":
          await this.onRuns();
          return;
        case "cost":
          await this.onCost(command);
          return;
        case "pause":
          await this.onPause(command);
          return;
        case "resume":
          await this.onResume(command);
          return;
        case "help":
        case "start":
          await this.transport.sendMessage({ text: HELP_TEXT });
          return;
        default:
          await this.transport.sendMessage({
            text: `Unknown command /${command.name}. Send /help for the list.`,
          });
          return;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error({ err: msg, command: command.name }, "command failed");
      await this.transport.sendMessage({ text: `Command failed: ${msg}` });
    }
  }

  // Command handlers --------------------------------------------------------

  private async onStatus(command: TelegramCommand): Promise<void> {
    const runId = this.resolveRunId(command);
    if (!runId) {
      await this.transport.sendMessage({ text: "No run id given and no default run set." });
      return;
    }
    const view = this.status(runId);
    if (!view) {
      await this.transport.sendMessage({ text: `No run found for ${shortId(runId)}.` });
      return;
    }
    await this.transport.sendMessage({ text: formatStatus(view) });
  }

  private async onRuns(): Promise<void> {
    const runs = this.listRuns();
    if (runs.length === 0) {
      await this.transport.sendMessage({ text: "No runs yet." });
      return;
    }
    const lines = runs.map(
      (r) => `${shortId(r.id)}  ${r.status.padEnd(11)}  $${r.costUsdSpent.toFixed(4)}  ${r.goal}`,
    );
    await this.transport.sendMessage({ text: ["Runs:", ...lines].join("\n") });
  }

  private async onCost(command: TelegramCommand): Promise<void> {
    const runId = this.resolveRunId(command);
    if (!runId) {
      await this.transport.sendMessage({ text: "No run id given and no default run set." });
      return;
    }
    const run = this.ledger.getRun(runId);
    if (!run) {
      await this.transport.sendMessage({ text: `No run found for ${shortId(runId)}.` });
      return;
    }
    await this.transport.sendMessage({ text: formatCost(run) });
  }

  private async onPause(command: TelegramCommand): Promise<void> {
    const runId = this.resolveRunId(command);
    if (!runId) {
      await this.transport.sendMessage({ text: "No run id given and no default run set." });
      return;
    }
    const run = this.ledger.getRun(runId);
    if (!run) {
      await this.transport.sendMessage({ text: `No run found for ${shortId(runId)}.` });
      return;
    }
    await this.supervisor.requestPause(runId);
    await this.transport.sendMessage({ text: `Pause requested for ${shortId(runId)}.` });
  }

  private async onResume(command: TelegramCommand): Promise<void> {
    const runId = this.resolveRunId(command);
    if (!runId) {
      await this.transport.sendMessage({ text: "No run id given and no default run set." });
      return;
    }
    const run = this.ledger.getRun(runId);
    if (!run) {
      await this.transport.sendMessage({ text: `No run found for ${shortId(runId)}.` });
      return;
    }
    await this.supervisor.requestResume(runId);
    await this.transport.sendMessage({ text: `Resume requested for ${shortId(runId)}.` });
  }

  // Helpers -----------------------------------------------------------------

  /**
   * Resolve the target run from an explicit arg or the configured default. An
   * arg is treated as a full id when an exact run exists, otherwise as a prefix
   * matched against listRuns so chat users can paste a short id.
   */
  private resolveRunId(command: TelegramCommand): string | undefined {
    const arg = command.args[0];
    if (!arg) return this.defaultRunId;
    if (this.ledger.getRun(arg)) return arg;
    const match = this.ledger.listRuns().find((r) => r.id.startsWith(arg));
    return match?.id ?? arg;
  }
}

// Formatting (pure, exported for tests via the surface output) --------------

function countByStatus(tasks: TaskRow[]): Map<TaskStatus, number> {
  const counts = new Map<TaskStatus, number>();
  for (const t of tasks) {
    counts.set(t.status, (counts.get(t.status) ?? 0) + 1);
  }
  return counts;
}

function formatStatus(view: RunStatusView): string {
  const { run, tasks, recentEvents } = view;
  const counts = countByStatus(tasks);
  const countLine =
    tasks.length === 0
      ? "tasks: none"
      : `tasks: ${tasks.length} (` +
        [...counts.entries()].map(([status, n]) => `${status} ${n}`).join(", ") +
        ")";

  const taskLines =
    tasks.length === 0
      ? []
      : ["", "Tasks:", ...tasks.map((t) => `  [${t.status}] ${t.slug}: ${t.title}`)];

  const eventLines =
    recentEvents.length === 0
      ? []
      : ["", "Recent events:", ...recentEvents.slice(-5).map(formatEvent)];

  return [
    `Run ${shortId(run.id)}  status: ${run.status}`,
    `goal: ${run.goal}`,
    `spent: $${run.costUsdSpent.toFixed(4)} / cap $${run.budgetUsdCap.toFixed(2)}`,
    countLine,
    ...taskLines,
    ...eventLines,
  ].join("\n");
}

function formatEvent(e: EventRow): string {
  return `  #${e.seq} ${e.type}`;
}

function formatCost(run: RunRow): string {
  const remaining = Math.max(0, run.budgetUsdCap - run.costUsdSpent);
  const pct = run.budgetUsdCap > 0 ? (run.costUsdSpent / run.budgetUsdCap) * 100 : 0;
  return [
    `Cost for run ${shortId(run.id)}`,
    `spent: $${run.costUsdSpent.toFixed(4)}`,
    `cap: $${run.budgetUsdCap.toFixed(2)}`,
    `remaining: $${remaining.toFixed(4)} (${pct.toFixed(1)}% used)`,
  ].join("\n");
}

export { parseCommand };
