import { describe, expect, it } from "vitest";

import type { EventRow } from "../../src/ledger/types";
import {
  formatEvents,
  type EventStreamLine,
} from "../../src/reporting/event-stream";

let nextSeq = 0;

function event(overrides: Partial<EventRow> = {}): EventRow {
  nextSeq += 1;
  return {
    id: `evt-${nextSeq}`,
    runId: "run-1",
    taskId: null,
    seq: nextSeq,
    type: "task.dispatched",
    payload: { foo: "bar" },
    createdAt: "2026-06-14T12:00:00.000Z",
    ...overrides,
  };
}

describe("formatEvents", () => {
  it("plain format outputs one line per event", () => {
    const out = formatEvents([event(), event(), event()], "plain");
    expect(out.split("\n")).toHaveLength(3);
  });

  it("plain format includes seq, type, timestamp, and taskId", () => {
    const out = formatEvents(
      [event({ seq: 7, type: "worker.started", taskId: "task-abc", createdAt: "2026-06-14T09:30:00.000Z" })],
      "plain",
    );
    expect(out).toContain("#7");
    expect(out).toContain("worker.started");
    expect(out).toContain("2026-06-14T09:30:00.000Z");
    expect(out).toContain("task=task-abc");
  });

  it("plain format encodes payload as inline JSON", () => {
    const out = formatEvents([event({ payload: { attempt: 2, ok: true } })], "plain");
    expect(out).toContain('{"attempt":2,"ok":true}');
  });

  it("json format outputs valid JSON per line", () => {
    const out = formatEvents([event(), event()], "json");
    const lines = out.split("\n");
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it("json format lines parse as EventStreamLine", () => {
    const out = formatEvents(
      [event({ seq: 3, type: "run.completed", taskId: null, payload: { status: "completed" } })],
      "json",
    );
    const parsed = JSON.parse(out) as EventStreamLine;
    expect(parsed.seq).toBe(3);
    expect(parsed.type).toBe("run.completed");
    expect(parsed.taskId).toBeNull();
    expect(parsed.timestamp).toBe("2026-06-14T12:00:00.000Z");
    // payload field is itself a JSON string
    expect(JSON.parse(parsed.payload)).toEqual({ status: "completed" });
  });

  it("returns an empty string for an empty array", () => {
    expect(formatEvents([], "plain")).toBe("");
    expect(formatEvents([], "json")).toBe("");
  });

  it("handles payloads with special characters", () => {
    const payload = { msg: 'he said "hi"', body: "line1\nline2", tab: "a\tb" };
    const plain = formatEvents([event({ payload })], "plain");
    // The whole event must stay on a single line: payload newlines are escaped.
    expect(plain.split("\n")).toHaveLength(1);
    const json = formatEvents([event({ payload })], "json");
    expect(json.split("\n")).toHaveLength(1);
    const parsed = JSON.parse(json) as EventStreamLine;
    expect(JSON.parse(parsed.payload)).toEqual(payload);
  });

  it("plain format omits the task field when taskId is null", () => {
    const out = formatEvents([event({ taskId: null })], "plain");
    expect(out).not.toContain("task=");
  });

  it("plain format renders the createdAt ISO timestamp", () => {
    const out = formatEvents([event({ createdAt: "2026-01-02T03:04:05.678Z" })], "plain");
    expect(out).toContain("2026-01-02T03:04:05.678Z");
  });

  it("rejects an unknown format rather than silently defaulting", () => {
    // @ts-expect-error deliberately passing an invalid format
    expect(() => formatEvents([event()], "yaml")).toThrow();
  });
});
