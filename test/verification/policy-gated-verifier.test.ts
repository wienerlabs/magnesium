import { describe, expect, it } from "vitest";

import type { TokenUsage } from "../../src/models/types";
import { CriticVerifier } from "../../src/verification/critic-verifier";
import { PolicyCriticVerifier } from "../../src/verification/policy-critic-verifier";
import { PolicyGatedVerifier } from "../../src/verification/policy-gated-verifier";
import type { Verdict, Verifier, VerifyInput } from "../../src/verification/verifier";
import { loadConfig } from "../../src/config/load";
import { StubModelClient } from "../fixtures/stub-model";

const config = loadConfig();

const input: VerifyInput = {
  taskId: "t1",
  kind: "generic",
  worktreePath: "/tmp/wt",
  title: "T",
  description: "d",
  acceptanceCriteria: ["c"],
  workerSummary: "done",
};

const USAGE: TokenUsage = {
  inputTokens: 11,
  outputTokens: 22,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
};

/** Records every call so tests can assert short-circuit behavior. */
class FakeVerifier implements Verifier {
  public calls = 0;
  constructor(private readonly verdict: Verdict) {}
  async verify(_input: VerifyInput): Promise<Verdict> {
    this.calls += 1;
    return this.verdict;
  }
}

describe("PolicyGatedVerifier", () => {
  it("passes when both base and policy verifiers pass", async () => {
    const base = new FakeVerifier({ pass: true, reason: "base ok", report: "b" });
    const policy = new FakeVerifier({ pass: true, reason: "policy ok", report: "p" });
    const gated = new PolicyGatedVerifier(base, policy);
    const verdict = await gated.verify(input);
    expect(verdict.pass).toBe(true);
    expect(base.calls).toBe(1);
    expect(policy.calls).toBe(1);
  });

  it("fails with base verdict reason when base verifier fails (short-circuits policy)", async () => {
    const base = new FakeVerifier({ pass: false, reason: "base failed", report: "b" });
    const policy = new FakeVerifier({ pass: true, reason: "policy ok" });
    const gated = new PolicyGatedVerifier(base, policy);
    const verdict = await gated.verify(input);
    expect(verdict.pass).toBe(false);
    expect(verdict.reason).toBe("base failed");
  });

  it("fails with policy verdict reason when base passes but policy fails", async () => {
    const base = new FakeVerifier({ pass: true, reason: "base ok" });
    const policy = new FakeVerifier({ pass: false, reason: "weapon_synthesis" });
    const gated = new PolicyGatedVerifier(base, policy);
    const verdict = await gated.verify(input);
    expect(verdict.pass).toBe(false);
    expect(verdict.reason).toContain("weapon_synthesis");
  });

  it("prefixes policy failure reason to indicate gate identity ('policy: ...')", async () => {
    const base = new FakeVerifier({ pass: true, reason: "base ok" });
    const policy = new FakeVerifier({ pass: false, reason: "malware_risk" });
    const gated = new PolicyGatedVerifier(base, policy);
    const verdict = await gated.verify(input);
    expect(verdict.reason).toBe("policy: malware_risk");
  });

  it("populates usage and costUsd from policy verifier when base passes (policy is called)", async () => {
    const base = new FakeVerifier({ pass: true, reason: "base ok" });
    const policy = new FakeVerifier({
      pass: true,
      reason: "policy ok",
      usage: USAGE,
      costUsd: 0.0042,
    });
    const gated = new PolicyGatedVerifier(base, policy);
    const verdict = await gated.verify(input);
    expect(verdict.usage).toEqual(USAGE);
    expect(verdict.costUsd).toBe(0.0042);
  });

  it("populates usage and costUsd from base verifier when base fails (policy is not called)", async () => {
    const base = new FakeVerifier({
      pass: false,
      reason: "base failed",
      usage: USAGE,
      costUsd: 0.0099,
    });
    const policy = new FakeVerifier({ pass: true, reason: "policy ok" });
    const gated = new PolicyGatedVerifier(base, policy);
    const verdict = await gated.verify(input);
    expect(verdict.usage).toEqual(USAGE);
    expect(verdict.costUsd).toBe(0.0099);
    expect(policy.calls).toBe(0);
  });

  it("does not call policy verifier if base verifier fails", async () => {
    const base = new FakeVerifier({ pass: false, reason: "base failed" });
    const policy = new FakeVerifier({ pass: true, reason: "policy ok" });
    const gated = new PolicyGatedVerifier(base, policy);
    await gated.verify(input);
    expect(policy.calls).toBe(0);
  });

  it("returns base verdict report unchanged when base fails", async () => {
    const base = new FakeVerifier({
      pass: false,
      reason: "base failed",
      report: "BASE_REPORT",
    });
    const policy = new FakeVerifier({ pass: true, reason: "policy ok" });
    const gated = new PolicyGatedVerifier(base, policy);
    const verdict = await gated.verify(input);
    expect(verdict.report).toBe("BASE_REPORT");
  });

  it("returns policy verdict report when policy fails", async () => {
    const base = new FakeVerifier({ pass: true, reason: "base ok" });
    const policy = new FakeVerifier({
      pass: false,
      reason: "copyright_violation",
      report: "POLICY_REPORT",
    });
    const gated = new PolicyGatedVerifier(base, policy);
    const verdict = await gated.verify(input);
    expect(verdict.report).toBe("POLICY_REPORT");
  });

  it("combines base verifier (CriticVerifier) with PolicyCriticVerifier in integration test", async () => {
    // Separate stub clients: both call purpose "critic", so they must not share
    // one StubModelClient or they would return the same response.
    const baseClient = new StubModelClient({
      critic: { pass: true, confidence: 0.9, reasons: ["criteria met"] },
    });
    const policyClient = new StubModelClient({
      critic: { pass: false, confidence: 0.8, policyViolations: ["weapon_synthesis"] },
    });
    const base = new CriticVerifier(baseClient, config);
    const policy = new PolicyCriticVerifier(policyClient, config);
    const gated = new PolicyGatedVerifier(base, policy);

    const verdict = await gated.verify(input);
    // Base passes criteria, but policy gate blocks on a weapon violation.
    expect(verdict.pass).toBe(false);
    expect(verdict.reason).toBe("policy: weapon_synthesis");
    expect(baseClient.calls).toHaveLength(1);
    expect(policyClient.calls).toHaveLength(1);
    // The returned verdict carries the policy call's cost fields for the engine.
    expect(verdict.usage).toBeDefined();
    expect(verdict.costUsd).toBeDefined();
  });

  it("passes the integration gate when both critic and policy approve", async () => {
    const baseClient = new StubModelClient({
      critic: { pass: true, confidence: 0.9, reasons: ["criteria met"] },
    });
    const policyClient = new StubModelClient({
      critic: { pass: true, confidence: 0.95, policyViolations: [] },
    });
    const gated = new PolicyGatedVerifier(
      new CriticVerifier(baseClient, config),
      new PolicyCriticVerifier(policyClient, config),
    );
    const verdict = await gated.verify(input);
    expect(verdict.pass).toBe(true);
    expect(verdict.reason).toBe("no policy violations");
  });
});
