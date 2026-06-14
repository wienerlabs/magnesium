import { createInterface } from "node:readline/promises";

export interface ConfirmableAction {
  kind: string;
  description: string;
  irreversible?: boolean;
}

/**
 * Human-in-the-loop gate for irreversible actions (push, force-push, rm -rf,
 * touching a real remote). This is also the seam for Telegram approval: a
 * Telegram implementation would answer confirm() from a chat callback.
 */
export interface ConfirmationGate {
  confirm(action: ConfirmableAction): Promise<boolean>;
}

export class CliConfirmationGate implements ConfirmationGate {
  constructor(private readonly autoApprove = false) {}

  async confirm(action: ConfirmableAction): Promise<boolean> {
    if (this.autoApprove) return true;
    // Without a TTY there is no human to ask, so deny by default. Irreversible
    // actions never proceed unattended.
    if (!process.stdin.isTTY) return false;
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = await rl.question(`Confirm ${action.kind}: ${action.description} [y/N] `);
      return answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes";
    } finally {
      rl.close();
    }
  }
}

/** Always denies. Safe default for fully non-interactive runs. */
export class DenyAllConfirmationGate implements ConfirmationGate {
  async confirm(): Promise<boolean> {
    return false;
  }
}
