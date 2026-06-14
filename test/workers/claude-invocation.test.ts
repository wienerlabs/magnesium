import { describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config/load";
import {
  buildClaudeArgs,
  buildContainerInvocation,
  mapWorkerResult,
  parseResultEvent,
} from "../../src/workers/claude-invocation";
import type { WorkerTask } from "../../src/workers/worker";

const config = loadConfig();

const task: WorkerTask = {
  runId: "run123456",
  taskId: "task78901234",
  slug: "slugify",
  title: "Build slugify",
  description: "implement it",
  acceptanceCriteria: ["tests pass"],
  kind: "code",
  model: "claude-sonnet-4-6",
  worktreePath: "/abs/worktrees/run/task",
};

describe("buildClaudeArgs", () => {
  const args = buildClaudeArgs(task, config, "/work");

  it("forces API billing with --bare (amendment 1)", () => {
    expect(args).toContain("--bare");
  });

  it("never bypasses destructive ops (amendment 3)", () => {
    const idx = args.indexOf("--permission-mode");
    expect(args[idx + 1]).toBe("acceptEdits");
    expect(args).not.toContain("bypassPermissions");
    expect(args).not.toContain("--dangerously-skip-permissions");
  });

  it("passes the model, per-worker budget cap, and an allowlist", () => {
    expect(args[args.indexOf("--model") + 1]).toBe("claude-sonnet-4-6");
    expect(args[args.indexOf("--max-budget-usd") + 1]).toBe(String(config.budget.perWorkerCapUsd));
    expect(args).toContain("--allowedTools");
    expect(args).toContain("Read");
  });
});

describe("buildContainerInvocation", () => {
  const { command, args } = buildContainerInvocation(task, config, "mg-test");

  it("runs via the docker CLI (OrbStack backend)", () => {
    expect(command).toBe("docker");
    expect(args[0]).toBe("run");
  });

  it("bind-mounts only the worktree and passes the API key through", () => {
    expect(args).toContain("-v");
    expect(args).toContain(`${task.worktreePath}:/work`);
    const eIdx = args.indexOf("-e");
    expect(args[eIdx + 1]).toBe("ANTHROPIC_API_KEY");
    expect(args).toContain(config.container.image);
  });

  it("invokes claude with --bare inside the container", () => {
    expect(args).toContain("claude");
    expect(args).toContain("--bare");
  });
});

describe("parseResultEvent and mapWorkerResult", () => {
  it("ignores non-result and non-json lines", () => {
    expect(parseResultEvent("not json")).toBeNull();
    expect(parseResultEvent(JSON.stringify({ type: "assistant" }))).toBeNull();
  });

  it("parses the result event and maps cost, usage, and success", () => {
    const line = JSON.stringify({
      type: "result",
      is_error: false,
      result: "done",
      session_id: "sess-1",
      num_turns: 3,
      total_cost_usd: 0.42,
      usage: { input_tokens: 100, output_tokens: 50 },
    });
    const event = parseResultEvent(line);
    expect(event).not.toBeNull();
    const mapped = mapWorkerResult(event, { code: 0, stderr: "", timedOut: false, aborted: false });
    expect(mapped.ok).toBe(true);
    expect(mapped.costUsd).toBeCloseTo(0.42);
    expect(mapped.sessionId).toBe("sess-1");
    expect(mapped.usage?.inputTokens).toBe(100);
  });

  it("reports a failure when no result event arrived", () => {
    const mapped = mapWorkerResult(null, { code: 1, stderr: "boom", timedOut: false, aborted: false });
    expect(mapped.ok).toBe(false);
    expect(mapped.error).toContain("boom");
  });

  it("flags an error result", () => {
    const event = parseResultEvent(
      JSON.stringify({ type: "result", is_error: true, result: "model error" }),
    );
    const mapped = mapWorkerResult(event, { code: 0, stderr: "", timedOut: false, aborted: false });
    expect(mapped.ok).toBe(false);
    expect(mapped.error).toContain("model error");
  });
});
