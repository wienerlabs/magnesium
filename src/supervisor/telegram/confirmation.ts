import type { Logger } from "../../logging/logger";
import { uuid } from "../../util/ids";
import type { ConfirmableAction, ConfirmationGate } from "../confirmation";
import type { TelegramCallback, TelegramTransport } from "./transport";

/** Five minutes. After this a pending confirmation auto-rejects (deny-safe). */
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export interface TelegramConfirmationGateOptions {
  transport: TelegramTransport;
  logger: Logger;
  /** Override the pending-action timeout. Defaults to five minutes. */
  timeoutMs?: number;
}

interface Pending {
  resolve: (approved: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
  description: string;
}

/**
 * Telegram-backed ConfirmationGate. confirm() posts the action to chat with
 * Approve / Deny inline buttons and returns a promise that settles when the
 * matching callback arrives, the timeout fires (deny), or the gate is closed
 * (deny). Concurrent confirmations are tracked independently by action id.
 *
 * No grammy import: every interaction is mediated by the injected transport, so
 * the whole gate is exercised in tests with a mock transport.
 */
export class TelegramConfirmationGate implements ConfirmationGate {
  private readonly transport: TelegramTransport;
  private readonly logger: Logger;
  private readonly timeoutMs: number;
  private readonly pending = new Map<string, Pending>();
  private readonly unsubscribe: () => void;
  private closed = false;

  constructor(opts: TelegramConfirmationGateOptions) {
    this.transport = opts.transport;
    this.logger = opts.logger;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.unsubscribe = this.transport.onCallback((cb) => this.handleCallback(cb));
  }

  async confirm(action: ConfirmableAction): Promise<boolean> {
    if (this.closed) return false;

    const id = uuid();
    const label = action.irreversible ? "[IRREVERSIBLE] " : "";
    const text = [
      `${label}Approval needed: ${action.kind}`,
      action.description,
      "",
      "Approve or Deny below.",
    ].join("\n");

    // Build the promise BEFORE sending so a fast callback cannot race a missing
    // entry. If the send rejects, tear the entry down and let the error bubble.
    const result = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          this.logger.warn({ actionId: id, kind: action.kind }, "confirmation timed out: denying");
          resolve(false);
        }
      }, this.timeoutMs);
      // Do not keep the event loop alive solely for a pending confirmation.
      timer.unref?.();
      this.pending.set(id, { resolve, timer, description: action.description });
    });

    try {
      await this.transport.sendMessage({
        text,
        buttons: [
          { text: "Approve", data: `approve:${id}` },
          { text: "Deny", data: `deny:${id}` },
        ],
      });
    } catch (err) {
      this.settle(id, false);
      throw err;
    }

    return result;
  }

  /** Reject all outstanding confirmations (deny) and stop listening. */
  close(): void {
    this.closed = true;
    this.unsubscribe();
    for (const id of [...this.pending.keys()]) {
      this.settle(id, false);
    }
  }

  private handleCallback(cb: TelegramCallback): void {
    const parsed = parseDecision(cb.data);
    if (!parsed) return;
    const { decision, actionId } = parsed;
    // Unknown / already-settled action ids are safely ignored (idempotent).
    if (!this.pending.has(actionId)) {
      this.logger.debug({ actionId, decision }, "callback for unknown action ignored");
      return;
    }
    this.settle(actionId, decision === "approve");
  }

  private settle(id: string, approved: boolean): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    entry.resolve(approved);
  }
}

/** Parse a callback payload "approve:<id>" / "deny:<id>" into its parts. */
export function parseDecision(
  data: string,
): { decision: "approve" | "deny"; actionId: string } | null {
  const idx = data.indexOf(":");
  if (idx <= 0) return null;
  const decision = data.slice(0, idx);
  const actionId = data.slice(idx + 1);
  if (actionId.length === 0) return null;
  if (decision !== "approve" && decision !== "deny") return null;
  return { decision, actionId };
}
