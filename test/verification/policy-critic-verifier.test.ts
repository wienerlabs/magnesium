import { describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config/load";
import {
  PolicyCriticVerifier,
  PolicyVerdictSchema,
} from "../../src/verification/policy-critic-verifier";
import type { VerifyInput } from "../../src/verification/verifier";
import { StubModelClient } from "../fixtures/stub-model";

const config = loadConfig();

const baseInput: VerifyInput = {
  taskId: "t1",
  kind: "generic",
  worktreePath: "/tmp/wt",
  title: "Draft a launch announcement",
  description: "Write a short announcement for the product launch.",
  acceptanceCriteria: ["one paragraph", "neutral tone"],
  workerSummary: "Wrote a one-paragraph neutral announcement.",
};

function verifierWith(response: unknown): {
  verifier: PolicyCriticVerifier;
  client: StubModelClient;
} {
  const client = new StubModelClient({ critic: response });
  return { verifier: new PolicyCriticVerifier(client, config), client };
}

describe("PolicyCriticVerifier", () => {
  it("passes when policy critic returns pass with empty violations", async () => {
    const { verifier } = verifierWith({
      pass: true,
      confidence: 0.95,
      policyViolations: [],
    });
    const verdict = await verifier.verify(baseInput);
    expect(verdict.pass).toBe(true);
    expect(verdict.reason).toBe("no policy violations");
  });

  it("fails when policy critic returns pass=false with weapon_synthesis violation", async () => {
    const { verifier } = verifierWith({
      pass: false,
      confidence: 0.8,
      policyViolations: ["weapon_synthesis"],
    });
    const verdict = await verifier.verify(baseInput);
    expect(verdict.pass).toBe(false);
    expect(verdict.reason).toBe("weapon_synthesis");
  });

  it("fails when policy critic returns pass=false with real_public_figure_persuasion violation", async () => {
    const { verifier } = verifierWith({
      pass: false,
      confidence: 0.7,
      policyViolations: ["real_public_figure_persuasion"],
    });
    const verdict = await verifier.verify(baseInput);
    expect(verdict.pass).toBe(false);
    expect(verdict.reason).toBe("real_public_figure_persuasion");
  });

  it("fails when policy critic returns pass=false with malware_risk violation", async () => {
    const { verifier } = verifierWith({
      pass: false,
      confidence: 0.9,
      policyViolations: ["malware_risk"],
    });
    const verdict = await verifier.verify(baseInput);
    expect(verdict.pass).toBe(false);
    expect(verdict.reason).toBe("malware_risk");
  });

  it("fails when policy critic returns pass=false with safety_wellbeing violation", async () => {
    const { verifier } = verifierWith({
      pass: false,
      confidence: 0.85,
      policyViolations: ["safety_wellbeing"],
    });
    const verdict = await verifier.verify(baseInput);
    expect(verdict.pass).toBe(false);
    expect(verdict.reason).toBe("safety_wellbeing");
  });

  it("fails when policy critic returns pass=false with copyright_violation violation", async () => {
    const { verifier } = verifierWith({
      pass: false,
      confidence: 0.6,
      policyViolations: ["copyright_violation"],
    });
    const verdict = await verifier.verify(baseInput);
    expect(verdict.pass).toBe(false);
    expect(verdict.reason).toBe("copyright_violation");
  });

  it("fails when policy critic returns pass=false with evenhandedness_doubt violation", async () => {
    const { verifier } = verifierWith({
      pass: false,
      confidence: 0.55,
      policyViolations: ["evenhandedness_doubt"],
    });
    const verdict = await verifier.verify(baseInput);
    expect(verdict.pass).toBe(false);
    expect(verdict.reason).toBe("evenhandedness_doubt");
  });

  it("fails with multiple violations (weapon_synthesis + malware_risk)", async () => {
    const { verifier } = verifierWith({
      pass: false,
      confidence: 0.92,
      policyViolations: ["weapon_synthesis", "malware_risk"],
    });
    const verdict = await verifier.verify(baseInput);
    expect(verdict.pass).toBe(false);
    expect(verdict.reason).toBe("weapon_synthesis, malware_risk");
  });

  it("populates usage and costUsd in verdict so engine can record the llm_call", async () => {
    const { verifier } = verifierWith({
      pass: true,
      confidence: 0.99,
      policyViolations: [],
    });
    const verdict = await verifier.verify(baseInput);
    expect(verdict.usage).toBeDefined();
    expect(verdict.costUsd).toBeDefined();
  });

  it("uses config.models.critic as the model", async () => {
    const { verifier, client } = verifierWith({
      pass: true,
      confidence: 0.9,
      policyViolations: [],
    });
    await verifier.verify(baseInput);
    expect(client.calls[0]?.purpose).toBe("critic");
    expect(client.calls[0]?.model).toBe(config.models.critic);
  });

  it("includes worker summary in the policy critique request", async () => {
    let capturedUser = "";
    const client = {
      calls: [] as { purpose: string; model: string }[],
      async structured(req: {
        purpose: string;
        model: string;
        user: string;
        schema: typeof PolicyVerdictSchema;
      }) {
        this.calls.push({ purpose: req.purpose, model: req.model });
        capturedUser = req.user;
        const value = req.schema.parse({
          pass: true,
          confidence: 1,
          policyViolations: [],
        });
        return {
          value,
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
          },
          costUsd: 0,
          model: req.model,
        };
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const verifier = new PolicyCriticVerifier(client as any, config);
    await verifier.verify({
      ...baseInput,
      workerSummary: "A UNIQUE WORKER SUMMARY MARKER",
    });
    expect(capturedUser).toContain("A UNIQUE WORKER SUMMARY MARKER");
  });

  it("includes task title and description in the policy critique request", async () => {
    let capturedUser = "";
    const client = {
      calls: [] as { purpose: string; model: string }[],
      async structured(req: {
        purpose: string;
        model: string;
        user: string;
        schema: typeof PolicyVerdictSchema;
      }) {
        this.calls.push({ purpose: req.purpose, model: req.model });
        capturedUser = req.user;
        const value = req.schema.parse({
          pass: true,
          confidence: 1,
          policyViolations: [],
        });
        return {
          value,
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
          },
          costUsd: 0,
          model: req.model,
        };
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const verifier = new PolicyCriticVerifier(client as any, config);
    await verifier.verify({
      ...baseInput,
      title: "TITLE_MARKER",
      description: "DESCRIPTION_MARKER",
    });
    expect(capturedUser).toContain("TITLE_MARKER");
    expect(capturedUser).toContain("DESCRIPTION_MARKER");
  });

  it("returns policy violations as comma-joined string in verdict.reason when pass=false", async () => {
    const { verifier } = verifierWith({
      pass: false,
      confidence: 0.4,
      policyViolations: ["safety_wellbeing", "copyright_violation"],
    });
    const verdict = await verifier.verify(baseInput);
    expect(verdict.pass).toBe(false);
    expect(verdict.reason).toBe("safety_wellbeing, copyright_violation");
  });

  it("returns confidence value in verdict.report for audit trail", async () => {
    const { verifier } = verifierWith({
      pass: true,
      confidence: 0.73,
      policyViolations: [],
    });
    const verdict = await verifier.verify(baseInput);
    expect(verdict.report).toBe("confidence=0.73");
  });

  it("treats model pass=true with a listed violation as a fail (derived pass)", async () => {
    const { verifier } = verifierWith({
      pass: true,
      confidence: 0.5,
      policyViolations: ["malware_risk"],
    });
    const verdict = await verifier.verify(baseInput);
    expect(verdict.pass).toBe(false);
    expect(verdict.reason).toBe("malware_risk");
  });

  it("PolicyVerdictSchema rejects out-of-range confidence", () => {
    expect(() =>
      PolicyVerdictSchema.parse({
        pass: true,
        confidence: 1.5,
        policyViolations: [],
      }),
    ).toThrow();
  });
});
