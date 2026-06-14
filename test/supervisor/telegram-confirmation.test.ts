import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createLogger } from "../../src/logging/logger";
import type { ConfirmableAction } from "../../src/supervisor/confirmation";
import {
  parseDecision,
  TelegramConfirmationGate,
} from "../../src/supervisor/telegram/confirmation";
import { MockTelegramTransport } from "../fixtures/mock-telegram-transport";

const logger = createLogger({ level: "silent" });

let transport: MockTelegramTransport;
let gate: TelegramConfirmationGate;

beforeEach(() => {
  transport = new MockTelegramTransport();
});

afterEach(() => {
  gate?.close();
  vi.useRealTimers();
});

const action: ConfirmableAction = { kind: "git-push", description: "push to origin/main" };

/** Pull the action id out of the buttons of the last sent message. */
function lastActionId(): string {
  const msg = transport.lastMessage();
  const approve = msg?.buttons?.find((b) => b.data.startsWith("approve:"));
  if (!approve) throw new Error("no approve button on last message");
  return approve.data.slice("approve:".length);
}

describe("TelegramConfirmationGate", () => {
  it("confirm() sends action description to chat and returns pending", async () => {
    gate = new TelegramConfirmationGate({ transport, logger });
    const pending = gate.confirm(action);
    // Allow the send microtask to flush so the message is recorded.
    await Promise.resolve();
    await Promise.resolve();
    expect(transport.sent).toHaveLength(1);
    expect(transport.lastMessage()?.text).toContain("push to origin/main");
    expect(transport.lastMessage()?.buttons).toHaveLength(2);

    // Settle so the test does not leak a pending promise.
    await transport.emitCallback(`deny:${lastActionId()}`);
    expect(await pending).toBe(false);
  });

  it("approval callback resolves pending confirm() to true", async () => {
    gate = new TelegramConfirmationGate({ transport, logger });
    const pending = gate.confirm(action);
    await Promise.resolve();
    await Promise.resolve();
    await transport.emitCallback(`approve:${lastActionId()}`);
    expect(await pending).toBe(true);
  });

  it("denial callback resolves pending confirm() to false", async () => {
    gate = new TelegramConfirmationGate({ transport, logger });
    const pending = gate.confirm(action);
    await Promise.resolve();
    await Promise.resolve();
    await transport.emitCallback(`deny:${lastActionId()}`);
    expect(await pending).toBe(false);
  });

  it("timeout after 5 minutes rejects pending confirm()", async () => {
    vi.useFakeTimers();
    gate = new TelegramConfirmationGate({ transport, logger });
    const pending = gate.confirm(action);
    // Flush the awaited sendMessage under fake timers.
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.sent).toHaveLength(1);
    // No callback arrives; advance past the five-minute window.
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1);
    expect(await pending).toBe(false);
  });

  it("multiple concurrent actions are tracked independently", async () => {
    gate = new TelegramConfirmationGate({ transport, logger });
    const first = gate.confirm({ kind: "push", description: "first" });
    await Promise.resolve();
    await Promise.resolve();
    const firstId = lastActionId();
    const second = gate.confirm({ kind: "rm", description: "second" });
    await Promise.resolve();
    await Promise.resolve();
    const secondId = lastActionId();

    expect(firstId).not.toBe(secondId);
    // Approve the second, deny the first; each resolves to its own decision.
    await transport.emitCallback(`approve:${secondId}`);
    await transport.emitCallback(`deny:${firstId}`);
    expect(await second).toBe(true);
    expect(await first).toBe(false);
  });

  it("irreversible actions mention [IRREVERSIBLE] in message", async () => {
    gate = new TelegramConfirmationGate({ transport, logger });
    const pending = gate.confirm({
      kind: "force-push",
      description: "force push main",
      irreversible: true,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(transport.lastMessage()?.text).toContain("[IRREVERSIBLE]");
    await transport.emitCallback(`deny:${lastActionId()}`);
    await pending;
  });

  it("confirm() raises on send failure (network error bubbles)", async () => {
    gate = new TelegramConfirmationGate({ transport, logger });
    transport.failNextSend = new Error("telegram 502");
    await expect(gate.confirm(action)).rejects.toThrow("telegram 502");
    // No message was recorded and nothing leaks as pending.
    expect(transport.sent).toHaveLength(0);
  });

  it("callback from unknown action ID is safely ignored", async () => {
    gate = new TelegramConfirmationGate({ transport, logger });
    const pending = gate.confirm(action);
    await Promise.resolve();
    await Promise.resolve();
    const realId = lastActionId();

    // A bogus id must not settle the real pending confirmation.
    await transport.emitCallback("approve:not-a-real-action-id");
    await transport.emitCallback("garbage-without-colon");
    await transport.emitCallback("approve:");

    // The real confirmation is still pending; approve it now to resolve.
    await transport.emitCallback(`approve:${realId}`);
    expect(await pending).toBe(true);
  });

  it("close() denies all outstanding confirmations", async () => {
    gate = new TelegramConfirmationGate({ transport, logger });
    const pending = gate.confirm(action);
    await Promise.resolve();
    await Promise.resolve();
    gate.close();
    expect(await pending).toBe(false);
  });
});

describe("parseDecision", () => {
  it("parses approve and deny payloads", () => {
    expect(parseDecision("approve:abc")).toEqual({ decision: "approve", actionId: "abc" });
    expect(parseDecision("deny:xyz")).toEqual({ decision: "deny", actionId: "xyz" });
  });

  it("rejects malformed payloads", () => {
    expect(parseDecision("approve")).toBeNull();
    expect(parseDecision("approve:")).toBeNull();
    expect(parseDecision("maybe:abc")).toBeNull();
    expect(parseDecision(":abc")).toBeNull();
  });
});
