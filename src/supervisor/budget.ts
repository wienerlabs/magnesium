import type { LedgerRepository } from "../ledger/repository";
import type { Logger } from "../logging/logger";

export interface BudgetRecordResult {
  spent: number;
  breached: boolean;
}

/**
 * Enforces the hard cost cap. Cost is sourced from the ledger (workers report
 * total_cost_usd; direct SDK calls compute from usage and config rates). Prices
 * are never hardcoded here. When the cap trips, the engine SIGTERMs in-flight
 * workers and checkpoints a resumable paused state (amendment 5).
 */
export class BudgetManager {
  constructor(
    private readonly ledger: LedgerRepository,
    private readonly runId: string,
    private readonly capUsd: number,
    private readonly perWorkerCapUsd: number,
    private readonly logger: Logger,
  ) {}

  spent(): number {
    return this.ledger.getRun(this.runId)?.costUsdSpent ?? 0;
  }

  remaining(): number {
    return Math.max(0, this.capUsd - this.spent());
  }

  /** True if there is room to start one more worker within the cap. */
  canDispatch(): boolean {
    return this.spent() + this.perWorkerCapUsd <= this.capUsd;
  }

  isBreached(): boolean {
    return this.spent() >= this.capUsd;
  }

  /** Atomically adds cost and reports whether the cap is now breached. */
  record(deltaUsd: number): BudgetRecordResult {
    const spent = this.ledger.addRunCost(this.runId, deltaUsd);
    const breached = spent >= this.capUsd;
    if (breached) {
      this.logger.warn({ runId: this.runId, spent, cap: this.capUsd }, "budget cap breached");
    }
    return { spent, breached };
  }
}
