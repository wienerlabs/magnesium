import { describe, expect, it } from "vitest";

import { mapWorkerResult } from "../../src/workers/claude-invocation";
import {
  ClaudeStreamAccumulator,
  outcomeToResultEvent,
  parseClaudeStreamLine,
} from "../../src/workers/stream-parser";

function line(obj: unknown): string {
  return JSON.stringify(obj);
}

describe("parseClaudeStreamLine", () => {
  it("ignores empty lines", () => {
    expect(parseClaudeStreamLine("")).toBeNull();
  });

  it("ignores whitespace-only lines", () => {
    expect(parseClaudeStreamLine("   \t  ")).toBeNull();
  });

  it("ignores non-JSON lines", () => {
    expect(parseClaudeStreamLine("hello world")).toBeNull();
    expect(parseClaudeStreamLine("[1, 2, 3]")).toBeNull();
  });

  it("ignores incomplete/truncated JSON", () => {
    expect(parseClaudeStreamLine('{"type":"result","total_cost')).toBeNull();
    expect(parseClaudeStreamLine('{"type":"assistant"')).toBeNull();
  });

  it("parses a valid system event with a subtype", () => {
    const event = parseClaudeStreamLine(line({ type: "system", subtype: "init", session_id: "s1" }));
    expect(event).not.toBeNull();
    expect(event?.type).toBe("system");
    expect(event?.subtype).toBe("init");
    expect(event?.session_id).toBe("s1");
  });

  it("parses a valid system event without a subtype", () => {
    const event = parseClaudeStreamLine(line({ type: "system" }));
    expect(event?.type).toBe("system");
    expect(event?.subtype).toBeUndefined();
  });

  it("parses a valid init event", () => {
    const event = parseClaudeStreamLine(line({ type: "init", session_id: "s2" }));
    expect(event?.type).toBe("init");
    expect(event?.session_id).toBe("s2");
  });

  it("parses a valid assistant event", () => {
    const event = parseClaudeStreamLine(line({ type: "assistant", usage: { output_tokens: 5 } }));
    expect(event?.type).toBe("assistant");
    expect(event?.subtype).toBeUndefined();
  });

  it("parses a valid user event", () => {
    const event = parseClaudeStreamLine(line({ type: "user" }));
    expect(event?.type).toBe("user");
  });

  it("parses a valid result event (success)", () => {
    const event = parseClaudeStreamLine(
      line({ type: "result", is_error: false, result: "done", total_cost_usd: 0.1 }),
    );
    expect(event?.type).toBe("result");
    expect(event?.is_error).toBe(false);
    expect(event?.result).toBe("done");
    expect(event?.total_cost_usd).toBeCloseTo(0.1);
  });

  it("parses a result event carrying an error subtype", () => {
    const event = parseClaudeStreamLine(
      line({ type: "result", is_error: true, subtype: "error_max_turns" }),
    );
    expect(event?.is_error).toBe(true);
    expect(event?.subtype).toBe("error_max_turns");
  });

  it("returns null for an unrecognized type", () => {
    expect(parseClaudeStreamLine(line({ type: "tool_use" }))).toBeNull();
    expect(parseClaudeStreamLine(line({ type: "stream_event" }))).toBeNull();
    expect(parseClaudeStreamLine(line({ foo: "bar" }))).toBeNull();
  });

  it("extracts a nested usage object when present", () => {
    const event = parseClaudeStreamLine(
      line({
        type: "assistant",
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: 10,
          cache_creation_input_tokens: 20,
        },
      }),
    );
    expect(event?.usage?.input_tokens).toBe(100);
    expect(event?.usage?.output_tokens).toBe(50);
    expect(event?.usage?.cache_read_input_tokens).toBe(10);
    expect(event?.usage?.cache_creation_input_tokens).toBe(20);
  });

  it("handles a very long line (>10KB) without stack overflow", () => {
    const big = "x".repeat(20000);
    const event = parseClaudeStreamLine(line({ type: "result", result: big, total_cost_usd: 1 }));
    expect(event?.result?.length).toBe(20000);
  });
});

describe("ClaudeStreamAccumulator", () => {
  it("initializes empty state", () => {
    const acc = new ClaudeStreamAccumulator();
    const outcome = acc.finalOutcome();
    expect(outcome.ok).toBe(true);
    expect(outcome.totalCostUsd).toBe(0);
    expect(outcome.sessionId).toBeUndefined();
    expect(outcome.usage).toBeUndefined();
    expect(outcome.result).toBeUndefined();
    expect(acc.resumeSessionId).toBeUndefined();
  });

  it("ignores non-events via processLine (null returns)", () => {
    const acc = new ClaudeStreamAccumulator();
    expect(acc.processLine("garbage")).toBeNull();
    expect(acc.processLine("")).toBeNull();
    expect(acc.processLine(null)).toBeNull();
    expect(acc.finalOutcome().ok).toBe(true);
  });

  it("tracks sessionId from the first event that carries session_id", () => {
    const acc = new ClaudeStreamAccumulator();
    acc.processLine(line({ type: "system" }));
    acc.processLine(line({ type: "init", session_id: "first" }));
    acc.processLine(line({ type: "assistant", session_id: "second" }));
    expect(acc.finalOutcome().sessionId).toBe("first");
  });

  it("tracks numTurns as the max of num_turns across all events", () => {
    const acc = new ClaudeStreamAccumulator();
    acc.processLine(line({ type: "assistant", num_turns: 1 }));
    acc.processLine(line({ type: "assistant", num_turns: 4 }));
    acc.processLine(line({ type: "result", num_turns: 3 }));
    expect(acc.finalOutcome().numTurns).toBe(4);
  });

  it("accumulates totalCostUsd as a sum across events", () => {
    const acc = new ClaudeStreamAccumulator();
    acc.processLine(line({ type: "assistant", total_cost_usd: 0.01 }));
    acc.processLine(line({ type: "assistant", total_cost_usd: 0.02 }));
    acc.processLine(line({ type: "result", total_cost_usd: 0.03 }));
    expect(acc.finalOutcome().totalCostUsd).toBeCloseTo(0.06, 6);
  });

  it("merges usage tokens additively", () => {
    const acc = new ClaudeStreamAccumulator();
    acc.processLine(
      line({
        type: "assistant",
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 1 },
      }),
    );
    acc.processLine(
      line({
        type: "assistant",
        usage: { input_tokens: 20, output_tokens: 7, cache_creation_input_tokens: 3 },
      }),
    );
    const usage = acc.finalOutcome().usage;
    expect(usage?.inputTokens).toBe(30);
    expect(usage?.outputTokens).toBe(12);
    expect(usage?.cacheReadTokens).toBe(1);
    expect(usage?.cacheCreationTokens).toBe(3);
  });

  it("captures the final result from a successful result event", () => {
    const acc = new ClaudeStreamAccumulator();
    acc.processLine(line({ type: "result", is_error: false, result: "shipped", session_id: "s" }));
    const outcome = acc.finalOutcome();
    expect(outcome.ok).toBe(true);
    expect(outcome.result).toBe("shipped");
    expect(outcome.errorSubtype).toBeUndefined();
  });

  it("captures the error subtype and result from an error result event", () => {
    const acc = new ClaudeStreamAccumulator();
    acc.processLine(
      line({ type: "result", is_error: true, subtype: "error_max_turns", result: "out of turns" }),
    );
    const outcome = acc.finalOutcome();
    expect(outcome.ok).toBe(false);
    expect(outcome.errorSubtype).toBe("error_max_turns");
    expect(outcome.result).toBe("out of turns");
  });

  it("reports ok=false when is_error is seen", () => {
    const acc = new ClaudeStreamAccumulator();
    acc.processLine(line({ type: "result", is_error: true }));
    expect(acc.finalOutcome().ok).toBe(false);
  });

  it("reports ok=false when an error subtype is set without is_error", () => {
    const acc = new ClaudeStreamAccumulator();
    acc.processLine(line({ type: "result", subtype: "error_during_execution" }));
    const outcome = acc.finalOutcome();
    expect(outcome.ok).toBe(false);
    expect(outcome.errorSubtype).toBe("error_during_execution");
  });

  it("omits undefined fields from the outcome", () => {
    const acc = new ClaudeStreamAccumulator();
    acc.processLine(line({ type: "result", is_error: false, total_cost_usd: 0.5 }));
    const outcome = acc.finalOutcome();
    expect("sessionId" in outcome).toBe(false);
    expect("usage" in outcome).toBe(false);
    expect("result" in outcome).toBe(false);
    expect(outcome.totalCostUsd).toBeCloseTo(0.5);
  });

  it("preserves errorSubtype for is_error events", () => {
    const acc = new ClaudeStreamAccumulator();
    acc.processLine(line({ type: "result", is_error: true, subtype: "error_max_turns" }));
    expect(acc.finalOutcome().errorSubtype).toBe("error_max_turns");
  });

  it("accumulates multiple assistant/user events without duplication", () => {
    const acc = new ClaudeStreamAccumulator();
    acc.processLine(line({ type: "assistant", usage: { output_tokens: 5 } }));
    acc.processLine(line({ type: "user" }));
    acc.processLine(line({ type: "assistant", usage: { output_tokens: 5 } }));
    acc.processLine(line({ type: "user" }));
    expect(acc.finalOutcome().usage?.outputTokens).toBe(10);
  });

  it("defaults undefined usage fields to 0", () => {
    const acc = new ClaudeStreamAccumulator();
    acc.processLine(line({ type: "assistant", usage: { input_tokens: 7 } }));
    const usage = acc.finalOutcome().usage;
    expect(usage?.inputTokens).toBe(7);
    expect(usage?.outputTokens).toBe(0);
    expect(usage?.cacheReadTokens).toBe(0);
    expect(usage?.cacheCreationTokens).toBe(0);
  });

  it("leaves usage undefined when no event carried a usage field", () => {
    const acc = new ClaudeStreamAccumulator();
    acc.processLine(line({ type: "result", is_error: false, result: "done" }));
    expect(acc.finalOutcome().usage).toBeUndefined();
  });

  it("keeps totalCostUsd accurate through decimals", () => {
    const acc = new ClaudeStreamAccumulator();
    acc.processLine(line({ type: "assistant", total_cost_usd: 0.0001 }));
    acc.processLine(line({ type: "assistant", total_cost_usd: 0.0002 }));
    acc.processLine(line({ type: "result", total_cost_usd: 0.0003 }));
    expect(acc.finalOutcome().totalCostUsd).toBeCloseTo(0.0006, 6);
  });

  it("updates resumeSessionId from the events", () => {
    const acc = new ClaudeStreamAccumulator();
    expect(acc.resumeSessionId).toBeUndefined();
    acc.processLine(line({ type: "init", session_id: "sess-resume" }));
    expect(acc.resumeSessionId).toBe("sess-resume");
    acc.processLine(line({ type: "result", is_error: false, session_id: "sess-resume" }));
    expect(acc.resumeSessionId).toBe("sess-resume");
  });

  it("yields ok=true, cost 0, no error for an empty stream", () => {
    const acc = new ClaudeStreamAccumulator();
    const outcome = acc.finalOutcome();
    expect(outcome.ok).toBe(true);
    expect(outcome.totalCostUsd).toBe(0);
    expect(outcome.errorSubtype).toBeUndefined();
  });

  it("ignores malformed result fields like a non-numeric cost", () => {
    const acc = new ClaudeStreamAccumulator();
    acc.processLine(line({ type: "result", is_error: false, total_cost_usd: "free", num_turns: "lots" }));
    const outcome = acc.finalOutcome();
    expect(outcome.totalCostUsd).toBe(0);
    expect(outcome.numTurns).toBeUndefined();
    expect(outcome.ok).toBe(true);
  });

  it("does not corrupt state on duplicate session_id values", () => {
    const acc = new ClaudeStreamAccumulator();
    acc.processLine(line({ type: "init", session_id: "dup" }));
    acc.processLine(line({ type: "assistant", session_id: "dup" }));
    acc.processLine(line({ type: "result", is_error: false, session_id: "dup" }));
    expect(acc.finalOutcome().sessionId).toBe("dup");
  });

  it("produces a ResultEvent compatible with mapWorkerResult", () => {
    const acc = new ClaudeStreamAccumulator();
    acc.processLine(line({ type: "system", subtype: "init", session_id: "sess-1" }));
    acc.processLine(line({ type: "assistant", usage: { input_tokens: 100, output_tokens: 50 } }));
    acc.processLine(
      line({ type: "result", is_error: false, result: "done", num_turns: 3, total_cost_usd: 0.42 }),
    );
    const mapped = mapWorkerResult(outcomeToResultEvent(acc.finalOutcome()), {
      code: 0,
      stderr: "",
      timedOut: false,
      aborted: false,
    });
    expect(mapped.ok).toBe(true);
    expect(mapped.costUsd).toBeCloseTo(0.42);
    expect(mapped.sessionId).toBe("sess-1");
    expect(mapped.numTurns).toBe(3);
    expect(mapped.summary).toBe("done");
    expect(mapped.usage?.inputTokens).toBe(100);
    expect(mapped.usage?.outputTokens).toBe(50);
  });

  it("maps an error outcome through to a failing WorkerResult", () => {
    const acc = new ClaudeStreamAccumulator();
    acc.processLine(line({ type: "result", is_error: true, subtype: "error_max_turns", result: "stop" }));
    const mapped = mapWorkerResult(outcomeToResultEvent(acc.finalOutcome()), {
      code: 0,
      stderr: "",
      timedOut: false,
      aborted: false,
    });
    expect(mapped.ok).toBe(false);
    expect(mapped.error).toBe("stop");
  });
});
