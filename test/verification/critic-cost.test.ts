import { describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config/load";
import { CriticVerifier } from "../../src/verification/critic-verifier";
import { StubModelClient } from "../fixtures/stub-model";

const config = loadConfig();

describe("CriticVerifier cost surfacing", () => {
  it("returns usage and cost so the engine can record an llm_call", async () => {
    const client = new StubModelClient({
      critic: { pass: true, confidence: 0.9, reasons: ["meets criteria"] },
    });
    const verifier = new CriticVerifier(client, config);
    const verdict = await verifier.verify({
      taskId: "t",
      kind: "generic",
      worktreePath: "/tmp",
      title: "T",
      description: "d",
      acceptanceCriteria: ["c"],
      workerSummary: "done",
    });
    expect(verdict.pass).toBe(true);
    expect(verdict.usage).toBeDefined();
    expect(verdict.costUsd).toBeDefined();
    expect(client.calls[0]?.purpose).toBe("critic");
  });
});
