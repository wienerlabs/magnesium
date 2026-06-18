import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SqliteLedger } from "../../src/ledger/sqlite/sqlite-ledger";
import type { RunRow } from "../../src/ledger/types";
import { createLogger } from "../../src/logging/logger";
import {
  ControlPlane,
  type EngineRunControl,
} from "../../src/supervisor/control-plane";
import { RunControlRegistry } from "../../src/runtime/run-control";
import { MockTelegramTransport } from "../fixtures/mock-telegram-transport";

const logger = createLogger({ level: "silent" });
const flush = () => new Promise((r) => setImmediate(r));

/**
 * Recording engine seam. Captures every resume(runId) call and optionally fails
 * the next one so the plane's error-handling path can be exercised offline.
 */
class StubEngine implements EngineRunControl {
  public readonly resumed: string[] = [];
  public failNextResume?: Error;

  async resume(runId: string): Promise<void> {
    if (this.failNextResume) {
      const err = this.failNextResume;
      this.failNextResume = undefined;
      throw err;
    }
    this.resumed.push(runId);
  }
}

let dir: string;
let ledger: SqliteLedger;
let transport: MockTelegramTransport;
let engine: StubEngine;
let registry: RunControlRegistry;
let plane: ControlPlane;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mg-control-plane-"));
  ledger = new SqliteLedger(join(dir, "ledger.db"));
  transport = new MockTelegramTransport();
  engine = new StubEngine();
  registry = new RunControlRegistry();
});

afterEach(async () => {
  plane?.stop();
  ledger.close();
  await rm(dir, { recursive: true, force: true });
  vi.useRealTimers();
});

function makeRun(goal = "ship it", cap = 5): RunRow {
  return ledger.createRun({
    goal,
    workspaceDir: "/tmp/ws",
    budgetUsdCap: cap,
    modelOrchestrator: "claude-opus-4-8",
    modelRouter: "claude-haiku-4-5",
  });
}

function build(defaultRunId?: string, gateTimeoutMs?: number): ControlPlane {
  plane = new ControlPlane({
    ledger,
    transport,
    engine,
    logger,
    registry,
    defaultRunId,
    gateTimeoutMs,
  });
  plane.start();
  return plane;
}

/** Pull the confirmation action id off the approve button of the last message. */
function lastConfirmActionId(): string {
  const approve = transport.lastMessage()?.buttons?.find((b) => b.data.startsWith("approve:"));
  if (!approve) throw new Error("no approve button on last message");
  return approve.data.slice("approve:".length);
}

/** Pull a button payload off the last message by data prefix (elicitation). */
function buttonByPrefix(prefix: string): string {
  const btn = transport.lastMessage()?.buttons?.find((b) => b.data.startsWith(prefix));
  if (!btn) throw new Error(`no button with data prefix ${prefix}`);
  return btn.data;
}

/** Find the approve action id from a specific sent-message index. */
function lastConfirmActionIdFrom(index: number): string {
  const msg = transport.sent[index];
  const approve = msg?.buttons?.find((b) => b.data.startsWith("approve:"));
  if (!approve) throw new Error(`no approve button on message ${index}`);
  return approve.data.slice("approve:".length);
}

describe("ControlPlane lifecycle", () => {
  it("start() subscribes the command surface; stop() unsubscribes", () => {
    build();
    expect(transport.hasCommandHandler()).toBe(true);
    expect(transport.hasCallbackHandler()).toBe(true);
    plane.stop();
    expect(transport.hasCommandHandler()).toBe(false);
    // Both gates closed: the fan-out detaches the single underlying callback.
    expect(transport.hasCallbackHandler()).toBe(false);
  });

  it("start() is idempotent (second call is a no-op)", async () => {
    const run = makeRun();
    build();
    plane.start();
    plane.start();
    // Still exactly one command handler; a /status routes once.
    await transport.emitCommand("status", [run.id]);
    expect(transport.allText()).toContain("ship it");
  });

  it("stop() is idempotent and terminal (cannot restart)", () => {
    build();
    plane.stop();
    plane.stop();
    expect(() => plane.start()).toThrow(/stopped/);
  });

  it("wires surface plus both gates over the one shared transport", async () => {
    build();
    // Confirmation and elicitation both ride the same transport: both render.
    const confirmP = plane.confirm({ kind: "git-push", description: "push main" });
    await flush();
    const elicitP = plane.elicit({
      questions: [{ question: "Pick", options: [{ key: "a", label: "A" }, { key: "b", label: "B" }] }],
    });
    await flush();

    // Two distinct messages were sent through the shared transport.
    expect(transport.sent.length).toBeGreaterThanOrEqual(2);
    const confirmId = lastConfirmActionIdFrom(0);
    const eselData = buttonByPrefix("esel:");

    // Settle both via interleaved callbacks; each gate ignores the other's data.
    await transport.emitCallback(eselData);
    await transport.emitCallback(`deny:${confirmId}`);
    expect((await elicitP).answered).toBe(true);
    expect(await confirmP).toBe(false);
  });
});

describe("ControlPlane pause/resume coordination", () => {
  it("routes a /pause command through the supervisor to the shared registry", async () => {
    const run = makeRun();
    build();
    await transport.emitCommand("pause", [run.id]);
    expect(registry.get(run.id).isPauseRequested()).toBe(true);
    expect(registry.get(run.id).state()).toBe("pause_requested");
    expect(transport.allText()).toContain("Pause requested");
  });

  it("routes a /resume command through the supervisor and re-enters the engine", async () => {
    const run = makeRun();
    ledger.updateRunStatus(run.id, "paused");
    build();
    // Drive the control into paused so resume is a valid transition.
    registry.get(run.id).requestPause();
    registry.get(run.id).markPaused();

    await transport.emitCommand("resume", [run.id]);
    expect(registry.get(run.id).state()).toBe("resume_requested");
    expect(engine.resumed).toEqual([run.id]);
    expect(transport.allText()).toContain("Resume requested");
  });

  it("resume() (direct API) calls engine.resume with the run id and sets resume_requested", async () => {
    const run = makeRun();
    build();
    registry.get(run.id).requestPause();
    registry.get(run.id).markPaused();

    await plane.resume(run.id);
    expect(engine.resumed).toEqual([run.id]);
    expect(registry.get(run.id).state()).toBe("resume_requested");
  });

  it("requestPause() (direct API) sets the cooperative pause flag", () => {
    const run = makeRun();
    build();
    plane.requestPause(run.id);
    expect(registry.get(run.id).isPauseRequested()).toBe(true);
  });

  it("the engine reads pause state from the same shared registry the surface drives", async () => {
    const run = makeRun();
    build();
    await transport.emitCommand("pause", [run.id]);
    // The engine would poll exactly this control instance in its loop.
    const control = registry.get(run.id);
    expect(control.isPauseRequested()).toBe(true);
    control.markPaused();
    expect(control.state()).toBe("paused");
  });

  it("resume re-entrance: a paused run resumes after the surface calls requestResume", async () => {
    const run = makeRun();
    build();
    const control = registry.get(run.id);
    control.requestPause();
    control.markPaused();
    expect(control.state()).toBe("paused");

    await transport.emitCommand("resume", [run.id]);
    expect(control.state()).toBe("resume_requested");
    expect(engine.resumed).toEqual([run.id]);
    // The engine restarting its loop would call markRunning(); model that here.
    control.markRunning();
    expect(control.state()).toBe("running");
  });
});

describe("ControlPlane gates interleave over one transport", () => {
  it("confirmation and elicitation callbacks interleave without cross-settling", async () => {
    build();
    const confirmP = plane.confirm({ kind: "rm", description: "rm -rf node_modules" });
    await flush();
    const confirmId = lastConfirmActionId();

    const elicitP = plane.elicit({
      questions: [
        { question: "Strategy?", options: [{ key: "fast", label: "Fast" }, { key: "safe", label: "Safe" }] },
      ],
    });
    await flush();
    const eselData = buttonByPrefix("esel:");

    // A confirmation callback must NOT settle the elicitation and vice versa.
    await transport.emitCallback(`approve:${confirmId}`);
    expect(await confirmP).toBe(true);

    await transport.emitCallback(eselData);
    const resp = await elicitP;
    expect(resp.answered).toBe(true);
    expect(resp.answers[0]?.selected).toBe("fast");
  });

  it("a confirmation callback is ignored by the elicitation gate (no crash)", async () => {
    build();
    const elicitP = plane.elicit({
      questions: [{ question: "Q", options: [{ key: "a", label: "A" }, { key: "b", label: "B" }] }],
    });
    await flush();
    const eselData = buttonByPrefix("esel:");

    // Garbage / wrong-gate callbacks reach both gates; both ignore them safely.
    await transport.emitCallback("approve:not-a-real-id");
    await transport.emitCallback("garbage-without-colon");
    // The elicitation still settles on its own real callback.
    await transport.emitCallback(eselData);
    expect((await elicitP).answered).toBe(true);
  });
});

describe("ControlPlane close() / stop() denies pending gate requests", () => {
  it("stop() denies pending confirmations and elicitations", async () => {
    build();
    const confirmP = plane.confirm({ kind: "push", description: "push" });
    await flush();
    const elicitP = plane.elicit({
      questions: [{ question: "Q", options: [{ key: "a", label: "A" }, { key: "b", label: "B" }] }],
    });
    await flush();

    plane.stop();
    expect(await confirmP).toBe(false);
    expect((await elicitP).answered).toBe(false);
  });

  it("close() is an alias for stop()", async () => {
    build();
    const confirmP = plane.confirm({ kind: "push", description: "push" });
    await flush();
    plane.close();
    expect(await confirmP).toBe(false);
    // Underlying transport left with no handlers after close.
    expect(transport.hasCallbackHandler()).toBe(false);
    expect(transport.hasCommandHandler()).toBe(false);
  });
});

describe("ControlPlane error handling", () => {
  it("an engine.resume() failure does not crash the plane; state stays resume_requested", async () => {
    const run = makeRun();
    build();
    registry.get(run.id).requestPause();
    registry.get(run.id).markPaused();
    engine.failNextResume = new Error("engine offline");

    // Must not throw; the surface command loop stays alive.
    await transport.emitCommand("resume", [run.id]);
    expect(registry.get(run.id).state()).toBe("resume_requested");
    expect(engine.resumed).toEqual([]); // resume never recorded (it threw)
    expect(transport.allText()).toContain("Resume requested");

    // A subsequent retry succeeds; the plane is still healthy.
    await plane.resume(run.id);
    expect(engine.resumed).toEqual([run.id]);
  });

  it("a sendMessage failure on confirm bubbles but leaves the plane usable", async () => {
    const run = makeRun();
    build();
    transport.failNextSend = new Error("telegram 502");
    await expect(plane.confirm({ kind: "push", description: "push" })).rejects.toThrow("telegram 502");

    // The plane still serves chat commands after a transient send failure.
    await transport.emitCommand("status", [run.id]);
    expect(transport.allText()).toContain("ship it");
  });

  it("a callback for an unknown run id is created-on-demand by the registry (documented behavior)", async () => {
    build();
    // No run exists in the ledger, so the surface refuses pause with "No run found"
    // and never reaches the supervisor; the registry stays untouched for that id.
    await transport.emitCommand("pause", ["ghost-run-id"]);
    expect(transport.allText()).toContain("No run found");
    expect(registry.has("ghost-run-id")).toBe(false);

    // But a direct programmatic pause does create the control on demand.
    plane.requestPause("ghost-run-id");
    expect(registry.has("ghost-run-id")).toBe(true);
    expect(registry.get("ghost-run-id").isPauseRequested()).toBe(true);
  });
});

describe("ControlPlane concurrency and multi-run isolation", () => {
  it("a duplicate pause for the same run is logged and does not change state again", async () => {
    const run = makeRun();
    build();
    await transport.emitCommand("pause", [run.id]);
    const control = registry.get(run.id);
    expect(control.state()).toBe("pause_requested");

    // Second pause command: first wins, the duplicate is a no-op on state.
    await transport.emitCommand("pause", [run.id]);
    expect(control.state()).toBe("pause_requested");

    // Even after the engine marks it paused, a duplicate pause stays paused.
    control.markPaused();
    plane.requestPause(run.id);
    expect(control.state()).toBe("paused");
  });

  it("multiple runs get independent RunControl instances; pause on A does not affect B", async () => {
    const runA = makeRun("goal a");
    const runB = makeRun("goal b");
    build();

    await transport.emitCommand("pause", [runA.id]);
    expect(registry.get(runA.id).isPauseRequested()).toBe(true);
    expect(registry.get(runB.id).isPauseRequested()).toBe(false);
    expect(registry.get(runB.id).state()).toBe("running");

    await transport.emitCommand("pause", [runB.id]);
    expect(registry.get(runB.id).isPauseRequested()).toBe(true);
    // A and B are distinct control objects.
    expect(registry.get(runA.id)).not.toBe(registry.get(runB.id));
  });
});

describe("ControlPlane defaults", () => {
  it("defaults to a fresh registry when none is injected", () => {
    plane = new ControlPlane({ ledger, transport, engine, logger });
    plane.start();
    expect(plane.registry).toBeInstanceOf(RunControlRegistry);
  });

  it("honors a custom gate timeout (pending confirm auto-denies)", async () => {
    vi.useFakeTimers();
    build(undefined, 1000);
    const confirmP = plane.confirm({ kind: "push", description: "push" });
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1001);
    expect(await confirmP).toBe(false);
  });
});
