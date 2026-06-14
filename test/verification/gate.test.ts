import { describe, expect, it } from "vitest";

import { runVerificationGate, type GateDeps } from "../../src/verification/gate";
import type { Verdict } from "../../src/verification/verifier";
import type { WorkerResult, WorkerTask } from "../../src/workers/worker";

const baseTask: WorkerTask = {
  runId: "r",
  taskId: "t",
  slug: "t",
  title: "T",
  description: "d",
  acceptanceCriteria: ["c"],
  kind: "code",
  model: "m",
  worktreePath: "/tmp/wt",
};

const okWorker: WorkerResult = { ok: true, costUsd: 0.01, summary: "done" };

function deps(partial: Partial<GateDeps>): GateDeps {
  return {
    prepareWorktree: async () => {},
    dispatch: async () => okWorker,
    verify: async (): Promise<Verdict> => ({ pass: true, reason: "ok" }),
    ...partial,
  };
}

describe("runVerificationGate", () => {
  it("passes on the first attempt", async () => {
    const res = await runVerificationGate(baseTask, 2, deps({}));
    expect(res.pass).toBe(true);
    expect(res.attempts).toBe(1);
  });

  it("retries with prior failure context, then passes", async () => {
    const seenPriorFailures: (string | undefined)[] = [];
    let verifyCalls = 0;
    const res = await runVerificationGate(
      baseTask,
      3,
      deps({
        dispatch: async (task) => {
          seenPriorFailures.push(task.priorFailure);
          return okWorker;
        },
        verify: async () => {
          verifyCalls++;
          return verifyCalls < 2 ? { pass: false, reason: "bad" } : { pass: true, reason: "good" };
        },
      }),
    );
    expect(res.pass).toBe(true);
    expect(res.attempts).toBe(2);
    // first attempt has no prior failure, second carries it
    expect(seenPriorFailures[0]).toBeUndefined();
    expect(seenPriorFailures[1]).toContain("bad");
  });

  it("fails after exhausting attempts", async () => {
    const res = await runVerificationGate(
      baseTask,
      2,
      deps({ verify: async () => ({ pass: false, reason: "always bad" }) }),
    );
    expect(res.pass).toBe(false);
    expect(res.attempts).toBe(2);
    expect(res.failureReason).toContain("always bad");
  });

  it("retries when the worker itself fails", async () => {
    let calls = 0;
    const res = await runVerificationGate(
      baseTask,
      2,
      deps({
        dispatch: async () => {
          calls++;
          return calls < 2 ? { ok: false, costUsd: 0.01, error: "worker crashed" } : okWorker;
        },
      }),
    );
    expect(res.pass).toBe(true);
    expect(calls).toBe(2);
  });

  it("stops early when shouldContinue returns false (budget trip)", async () => {
    let dispatches = 0;
    const res = await runVerificationGate(
      baseTask,
      3,
      deps({
        shouldContinue: () => false,
        dispatch: async () => {
          dispatches++;
          return okWorker;
        },
      }),
    );
    expect(res.pass).toBe(false);
    expect(dispatches).toBe(0);
  });

  it("accumulates cost across attempts", async () => {
    const res = await runVerificationGate(
      baseTask,
      2,
      deps({
        dispatch: async () => ({ ok: true, costUsd: 0.05, summary: "x" }),
        verify: async () => ({ pass: true, reason: "ok" }),
      }),
    );
    expect(res.costUsd).toBeCloseTo(0.05);
  });
});
