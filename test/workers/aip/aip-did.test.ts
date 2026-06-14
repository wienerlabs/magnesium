import { describe, expect, it } from "vitest";

import {
  AIP_DID_REGEX,
  AipDidSchema,
  formatAipDid,
  parseAipDid,
} from "../../../src/workers/aip/aip-did";

describe("parseAipDid", () => {
  it("parses valid aip DIDs with base58-like wallet and slug agent_id", () => {
    const did = parseAipDid("did:aip:7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU:code-worker");
    expect(did.wallet).toBe("7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU");
    expect(did.agentId).toBe("code-worker");
    expect(did.did).toBe(
      "did:aip:7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU:code-worker",
    );
  });

  it("accepts a single-segment slug agent_id with digits", () => {
    const did = parseAipDid("did:aip:Wallet99:agent-7");
    expect(did.agentId).toBe("agent-7");
  });

  it("rejects DIDs with an invalid scheme", () => {
    expect(() => parseAipDid("did:web:Wallet99:agent")).toThrow();
    expect(() => parseAipDid("aip:Wallet99:agent")).toThrow();
    expect(() => parseAipDid("did:aipx:Wallet99:agent")).toThrow();
  });

  it("rejects DIDs with empty wallet or agent_id", () => {
    expect(() => parseAipDid("did:aip::agent")).toThrow();
    expect(() => parseAipDid("did:aip:Wallet99:")).toThrow();
    expect(() => parseAipDid("did:aip::")).toThrow();
  });

  it("rejects DIDs with a non-slug agent_id (uppercase, spaces, underscores)", () => {
    expect(() => parseAipDid("did:aip:Wallet99:Agent")).toThrow();
    expect(() => parseAipDid("did:aip:Wallet99:agent worker")).toThrow();
    expect(() => parseAipDid("did:aip:Wallet99:agent_worker")).toThrow();
    expect(() => parseAipDid("did:aip:Wallet99:agent.worker")).toThrow();
  });

  it("rejects DIDs with invalid base58/wallet characters", () => {
    // Hyphen and non-alphanumerics are not allowed in the wallet segment.
    expect(() => parseAipDid("did:aip:wallet-99:agent")).toThrow();
    expect(() => parseAipDid("did:aip:wallet 99:agent")).toThrow();
    expect(() => parseAipDid("did:aip:wallet$:agent")).toThrow();
  });

  it("rejects DIDs with extra colons beyond the 3 parts", () => {
    expect(() => parseAipDid("did:aip:Wallet99:agent:extra")).toThrow();
    expect(() => parseAipDid("did:aip:Wallet99:agent:")).toThrow();
  });

  it("surfaces a soft result via safeParse without throwing", () => {
    const ok = AipDidSchema.safeParse("did:aip:Wallet99:agent");
    expect(ok.success).toBe(true);
    const bad = AipDidSchema.safeParse("not-a-did");
    expect(bad.success).toBe(false);
  });
});

describe("formatAipDid", () => {
  it("round-trips through parse and format", () => {
    const wallet = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
    const agentId = "code-worker";
    const formatted = formatAipDid(wallet, agentId);
    const parsed = parseAipDid(formatted);
    expect(parsed.wallet).toBe(wallet);
    expect(parsed.agentId).toBe(agentId);
    expect(formatAipDid(parsed.wallet, parsed.agentId)).toBe(formatted);
  });

  it("rejects inputs that would produce a malformed DID", () => {
    expect(() => formatAipDid("Wallet99", "Bad_Agent")).toThrow();
    expect(() => formatAipDid("bad-wallet", "agent")).toThrow();
    expect(() => formatAipDid("", "agent")).toThrow();
  });
});

describe("AIP_DID_REGEX", () => {
  it("is anchored and captures wallet and agent_id groups", () => {
    const match = AIP_DID_REGEX.exec("did:aip:Wallet99:my-agent");
    expect(match).not.toBeNull();
    expect(match?.[1]).toBe("Wallet99");
    expect(match?.[2]).toBe("my-agent");
  });
});
