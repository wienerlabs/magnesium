import { describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config/load";
import { runVerificationGate } from "../../src/verification/gate";
import { buildClaudeArgs } from "../../src/workers/claude-invocation";
import type { WorkerResult, WorkerTask } from "../../src/workers/worker";

const config = loadConfig();

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

describe("session resume plumbing", () => {
  it("omits --resume when no session id is carried", () => {
    expect(buildClaudeArgs(baseTask, config, "/work")).not.toContain("--resume");
  });

  it("adds --resume <id> before the variadic --allowedTools", () => {
    const args = buildClaudeArgs({ ...baseTask, resumeSessionId: "sess-42" }, config, "/work");
    const ri = args.indexOf("--resume");
    expect(ri).toBeGreaterThan(-1);
    expect(args[ri + 1]).toBe("sess-42");
    expect(ri).toBeLessThan(args.indexOf("--allowedTools"));
  });

  it("carries the prior session id into a retry when resumeOnRetry is on", async () => {
    const seen: (string | undefined)[] = [];
    let n = 0;
    const res = await runVerificationGate(baseTask, 2, {
      resumeOnRetry: true,
      prepareWorktree: async () => {},
      dispatch: async (task): Promise<WorkerResult> => {
        seen.push(task.resumeSessionId);
        n += 1;
        return { ok: true, costUsd: 0.01, summary: "x", sessionId: `s${n}` };
      },
      verify: async () => (n < 2 ? { pass: false, reason: "bad" } : { pass: true, reason: "good" }),
    });
    expect(res.pass).toBe(true);
    expect(seen[0]).toBeUndefined();
    expect(seen[1]).toBe("s1");
  });

  it("does not carry a session id when resumeOnRetry is off (clean re-run)", async () => {
    const seen: (string | undefined)[] = [];
    let n = 0;
    const res = await runVerificationGate(baseTask, 2, {
      prepareWorktree: async () => {},
      dispatch: async (task): Promise<WorkerResult> => {
        seen.push(task.resumeSessionId);
        n += 1;
        return { ok: true, costUsd: 0, summary: "x", sessionId: `s${n}` };
      },
      verify: async () => (n < 2 ? { pass: false, reason: "bad" } : { pass: true, reason: "good" }),
    });
    expect(res.pass).toBe(true);
    expect(seen[1]).toBeUndefined();
  });
});
