import type { LedgerRepository } from "../ledger/repository";
import type { EventRow, RunRow, TaskDep, TaskRow } from "../ledger/types";

export interface RunStatusView {
  run: RunRow;
  tasks: TaskRow[];
  deps: TaskDep[];
  recentEvents: EventRow[];
}

/**
 * Read interface onto a run for any control surface. Phase 1 ships a CLI-backed
 * view. The Telegram surface is a future implementation of this interface, plus
 * pause/resume/confirm commands routed through the supervisor.
 */
export interface ControlSurface {
  status(runId: string): RunStatusView | null;
  listRuns(): RunRow[];
}

export class LedgerControlSurface implements ControlSurface {
  constructor(private readonly ledger: LedgerRepository) {}

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
}
