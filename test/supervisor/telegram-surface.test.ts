import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SqliteLedger } from "../../src/ledger/sqlite/sqlite-ledger";
import { createLogger } from "../../src/logging/logger";
import type { RunRow } from "../../src/ledger/types";
import {
  TelegramControlSurface,
  type RunSupervisor,
} from "../../src/supervisor/telegram/surface";
import { MockTelegramTransport } from "../fixtures/mock-telegram-transport";

const logger = createLogger({ level: "silent" });

class RecordingSupervisor implements RunSupervisor {
  public readonly paused: string[] = [];
  public readonly resumed: string[] = [];
  requestPause(runId: string): void {
    this.paused.push(runId);
  }
  requestResume(runId: string): void {
    this.resumed.push(runId);
  }
}

let dir: string;
let ledger: SqliteLedger;
let transport: MockTelegramTransport;
let supervisor: RecordingSupervisor;
let surface: TelegramControlSurface;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mg-tg-surface-"));
  ledger = new SqliteLedger(join(dir, "ledger.db"));
  transport = new MockTelegramTransport();
  supervisor = new RecordingSupervisor();
});

afterEach(async () => {
  surface?.stop();
  ledger.close();
  await rm(dir, { recursive: true, force: true });
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

function build(defaultRunId?: string): TelegramControlSurface {
  surface = new TelegramControlSurface({ ledger, transport, supervisor, logger, defaultRunId });
  surface.start();
  return surface;
}

describe("TelegramControlSurface", () => {
  it("status() returns RunStatusView with formatted task list", () => {
    const run = makeRun();
    ledger.createTask({
      runId: run.id,
      slug: "alpha",
      title: "First task",
      description: "do alpha",
      acceptanceCriteria: ["works"],
      kind: "code",
      maxAttempts: 2,
    });
    build();
    const view = surface.status(run.id);
    expect(view).not.toBeNull();
    expect(view?.run.id).toBe(run.id);
    expect(view?.tasks).toHaveLength(1);
    expect(view?.tasks[0]?.slug).toBe("alpha");
  });

  it("status() returns null for nonexistent run", () => {
    build();
    expect(surface.status("does-not-exist")).toBeNull();
  });

  it("listRuns() returns all runs from ledger", () => {
    const a = makeRun("goal a");
    const b = makeRun("goal b");
    build();
    const ids = surface.listRuns().map((r) => r.id);
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
  });

  it("pause command updates run status to paused via callback", async () => {
    const run = makeRun();
    build();
    await transport.emitCommand("pause", [run.id]);
    expect(supervisor.paused).toEqual([run.id]);
    expect(transport.allText()).toContain("Pause requested");
  });

  it("resume command updates run status to running via callback", async () => {
    const run = makeRun();
    ledger.updateRunStatus(run.id, "paused");
    build();
    await transport.emitCommand("resume", [run.id]);
    expect(supervisor.resumed).toEqual([run.id]);
    expect(transport.allText()).toContain("Resume requested");
  });

  it("status message includes task counts and recent event summary", async () => {
    const run = makeRun();
    ledger.createTask({
      runId: run.id,
      slug: "alpha",
      title: "First task",
      description: "do alpha",
      acceptanceCriteria: ["works"],
      kind: "code",
      maxAttempts: 2,
    });
    ledger.appendEvent({ runId: run.id, type: "run_started", payload: {} });
    build();
    await transport.emitCommand("status", [run.id]);
    const text = transport.allText();
    expect(text).toContain("tasks: 1");
    expect(text).toContain("pending 1");
    expect(text).toContain("Recent events");
    expect(text).toContain("run_started");
  });

  it("status command resolves a short id prefix", async () => {
    const run = makeRun();
    build();
    await transport.emitCommand("status", [run.id.slice(0, 8)]);
    expect(transport.allText()).toContain(run.id.slice(0, 8));
    expect(transport.allText()).toContain("ship it");
  });

  it("cost command reports current spend and remaining budget", async () => {
    const run = makeRun("budget run", 10);
    ledger.addRunCost(run.id, 2.5);
    build();
    await transport.emitCommand("cost", [run.id]);
    const text = transport.allText();
    expect(text).toContain("spent: $2.5000");
    expect(text).toContain("cap: $10.00");
    expect(text).toContain("remaining: $7.5000");
    expect(text).toContain("25.0% used");
  });

  it("help command lists available commands", async () => {
    build();
    await transport.emitCommand("help");
    const text = transport.allText();
    expect(text).toContain("/status");
    expect(text).toContain("/cost");
    expect(text).toContain("/pause");
    expect(text).toContain("/resume");
    expect(text).toContain("/runs");
  });

  it("uses the default run id when a command omits one", async () => {
    const run = makeRun();
    build(run.id);
    await transport.emitCommand("status");
    expect(transport.allText()).toContain("ship it");
  });

  it("reports a clear error for an unknown run id", async () => {
    build();
    await transport.emitCommand("cost", ["totally-unknown-id-xyz"]);
    expect(transport.allText()).toContain("No run found");
  });

  it("reports unknown commands without throwing", async () => {
    build();
    await transport.emitCommand("frobnicate");
    expect(transport.allText()).toContain("Unknown command");
  });

  it("stop() unsubscribes the command handler", () => {
    build();
    expect(transport.hasCommandHandler()).toBe(true);
    surface.stop();
    expect(transport.hasCommandHandler()).toBe(false);
  });
});
