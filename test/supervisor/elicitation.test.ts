import { describe, expect, it } from "vitest";

import { createLogger } from "../../src/logging/logger";
import {
  ElicitationRequestSchema,
  TelegramElicitationGate,
  parseElicitationCallback,
} from "../../src/supervisor/elicitation";
import { MockTelegramTransport } from "../fixtures/mock-telegram-transport";

const logger = createLogger({ level: "silent" });
const flush = () => new Promise((r) => setImmediate(r));

function buttonByPrefix(transport: MockTelegramTransport, prefix: string): string {
  const btn = transport.lastMessage()?.buttons?.find((b) => b.data.startsWith(prefix));
  if (!btn) throw new Error(`no button with data prefix ${prefix}`);
  return btn.data;
}

describe("ElicitationRequestSchema", () => {
  it("accepts 2-4 options and 1-3 questions, applies single_select default", () => {
    const parsed = ElicitationRequestSchema.parse({
      questions: [{ question: "Pick", options: [{ key: "a", label: "A" }, { key: "b", label: "B" }] }],
    });
    expect(parsed.questions[0]?.type).toBe("single_select");
  });

  it("rejects fewer than 2 options", () => {
    expect(() =>
      ElicitationRequestSchema.parse({ questions: [{ question: "Q", options: [{ key: "a", label: "A" }] }] }),
    ).toThrow();
  });

  it("rejects duplicate option keys", () => {
    expect(() =>
      ElicitationRequestSchema.parse({
        questions: [{ question: "Q", options: [{ key: "a", label: "A" }, { key: "a", label: "B" }] }],
      }),
    ).toThrow();
  });
});

describe("parseElicitationCallback", () => {
  it("parses a keyed callback", () => {
    expect(parseElicitationCallback("esel:r1:0:a")).toEqual({
      kind: "esel",
      requestId: "r1",
      questionIndex: 0,
      key: "a",
    });
  });

  it("parses a keyless commit callback", () => {
    expect(parseElicitationCallback("emuldone:r1:2")).toEqual({
      kind: "emuldone",
      requestId: "r1",
      questionIndex: 2,
    });
  });

  it("rejects malformed payloads", () => {
    expect(parseElicitationCallback("nope")).toBeNull();
    expect(parseElicitationCallback("esel:r1:0")).toBeNull(); // missing key
    expect(parseElicitationCallback("emuldone:r1:0:x")).toBeNull(); // extra key
  });
});

describe("TelegramElicitationGate", () => {
  it("resolves a single_select on the matching button press", async () => {
    const transport = new MockTelegramTransport();
    const gate = new TelegramElicitationGate({ transport, logger });
    const promise = gate.elicit({
      questions: [{ question: "Pick one", options: [{ key: "a", label: "A" }, { key: "b", label: "B" }] }],
    });
    await flush();

    await transport.emitCallback(buttonByPrefix(transport, "esel:") /* the A button */);
    const res = await promise;

    expect(res.answered).toBe(true);
    expect(res.answers[0]?.selected).toBe("a");
  });

  it("toggles and confirms a multi_select", async () => {
    const transport = new MockTelegramTransport();
    const gate = new TelegramElicitationGate({ transport, logger });
    const promise = gate.elicit({
      questions: [
        {
          question: "Pick many",
          type: "multi_select",
          options: [{ key: "a", label: "A" }, { key: "b", label: "B" }, { key: "c", label: "C" }],
        },
      ],
    });
    await flush();

    await transport.emitCallback("emul:" + extractId(transport) + ":0:a");
    await flush();
    await transport.emitCallback("emul:" + extractId(transport) + ":0:b");
    await flush();
    await transport.emitCallback(buttonByPrefix(transport, "emuldone:"));
    const res = await promise;

    expect(res.answered).toBe(true);
    expect(res.answers[0]?.selectedMany).toEqual(["a", "b"]);
  });

  it("collects a ranking in tap order", async () => {
    const transport = new MockTelegramTransport();
    const gate = new TelegramElicitationGate({ transport, logger });
    const promise = gate.elicit({
      questions: [
        {
          question: "Rank",
          type: "rank_priorities",
          options: [{ key: "a", label: "A" }, { key: "b", label: "B" }],
        },
      ],
    });
    await flush();

    await transport.emitCallback("erank:" + extractId(transport) + ":0:b");
    await flush();
    await transport.emitCallback("erank:" + extractId(transport) + ":0:a");
    await flush();
    await transport.emitCallback(buttonByPrefix(transport, "erankdone:"));
    const res = await promise;

    expect(res.answered).toBe(true);
    expect(res.answers[0]?.selectedMany).toEqual(["b", "a"]);
  });

  it("denies on timeout with no answer", async () => {
    const transport = new MockTelegramTransport();
    const gate = new TelegramElicitationGate({ transport, logger, timeoutMs: 25 });
    const res = await gate.elicit({
      questions: [{ question: "Q", options: [{ key: "a", label: "A" }, { key: "b", label: "B" }] }],
    });
    expect(res.answered).toBe(false);
    expect(res.answers[0]?.answered).toBe(false);
  });
});

/** Extract the active request id from the data of the first button in the last message. */
function extractId(transport: MockTelegramTransport): string {
  const data = transport.lastMessage()?.buttons?.[0]?.data;
  if (!data) throw new Error("no buttons to extract id from");
  return data.split(":")[1] as string;
}
