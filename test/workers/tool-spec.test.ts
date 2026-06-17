import { describe, expect, it } from "vitest";
import { z } from "zod";

import { loadConfig } from "../../src/config/load";
import {
  DEFAULT_TOOL_SPECS,
  renderToolGuidance,
  validateToolSpecRegistry,
  type ToolSpec,
} from "../../src/workers/tool-spec";

const config = loadConfig();

/** A minimal valid spec for positive-path assertions. */
const goodSpec: ToolSpec = {
  name: "Probe",
  purpose: "do a thing",
  whenToUse: "when a thing is needed",
};

function findSpec(name: string): ToolSpec {
  const spec = DEFAULT_TOOL_SPECS.find((s) => s.name === name);
  if (!spec) throw new Error(`expected a spec named ${name}`);
  return spec;
}

const bashSpec = DEFAULT_TOOL_SPECS.find((s) => s.name.startsWith("Bash("));

describe("ToolSpec type and validation", () => {
  it("accepts a spec with only the required fields", () => {
    expect(() => validateToolSpecRegistry([goodSpec])).not.toThrow();
  });

  it("accepts the optional whenNotToUse and gating fields", () => {
    const full: ToolSpec = {
      ...goodSpec,
      whenNotToUse: "never on tuesdays",
      gating: "blocked by policy",
    };
    expect(() => validateToolSpecRegistry([full])).not.toThrow();
  });

  it("throws when a required field is missing", () => {
    const missing = { name: "X", purpose: "p" } as unknown as ToolSpec;
    expect(() => validateToolSpecRegistry([missing])).toThrow(z.ZodError);
  });

  it("throws when a required string is empty or whitespace", () => {
    const blank: ToolSpec = { name: "  ", purpose: "p", whenToUse: "w" };
    expect(() => validateToolSpecRegistry([blank])).toThrow(z.ZodError);
  });

  it("throws when an optional field is present but empty", () => {
    const emptyOptional: ToolSpec = { ...goodSpec, whenNotToUse: "" };
    expect(() => validateToolSpecRegistry([emptyOptional])).toThrow(z.ZodError);
  });

  it("throws when two specs share the same name", () => {
    expect(() => validateToolSpecRegistry([goodSpec, { ...goodSpec }])).toThrow(
      /duplicate tool spec name/,
    );
  });

  it("returns the validated registry on success", () => {
    expect(validateToolSpecRegistry([goodSpec])).toHaveLength(1);
  });
});

describe("DEFAULT_TOOL_SPECS registry", () => {
  it("passes validation without error", () => {
    expect(() => validateToolSpecRegistry(DEFAULT_TOOL_SPECS)).not.toThrow();
  });

  it("contains entries for Read, Write, Edit, a Bash family, and git", () => {
    expect(findSpec("Read")).toBeDefined();
    expect(findSpec("Write")).toBeDefined();
    expect(findSpec("Edit")).toBeDefined();
    expect(bashSpec).toBeDefined();
    expect(findSpec("git")).toBeDefined();
  });

  it("gives every spec coherent when-to-use guidance", () => {
    for (const spec of DEFAULT_TOOL_SPECS) {
      expect(spec.whenToUse.length).toBeGreaterThan(0);
      expect(spec.purpose.length).toBeGreaterThan(0);
    }
  });

  it("leaves Read, Write, and Edit ungated (no gating field)", () => {
    expect(findSpec("Read").gating).toBeUndefined();
    expect(findSpec("Write").gating).toBeUndefined();
    expect(findSpec("Edit").gating).toBeUndefined();
  });

  it("encodes the Bash family with concrete pattern matchers in whenToUse", () => {
    expect(bashSpec).toBeDefined();
    const bash = bashSpec as ToolSpec;
    // The Bash entry must name the allowed command families explicitly.
    expect(bash.whenToUse).toContain("pnpm");
    expect(bash.whenToUse).toContain("npm");
    expect(bash.name).toContain("Bash(pnpm:*)");
    expect(bash.name).toContain("Bash(npm:*)");
    // It carries a gating note bounding it to the listed patterns.
    expect(bash.gating).toBeDefined();
  });

  it("mirrors the config.worker.allowedTools families", () => {
    // Guidance must mirror the allowlist, not exceed it. Every non-Bash
    // allowlisted tool has a matching spec name; every Bash pattern is named
    // inside the Bash spec.
    const specNames = new Set(DEFAULT_TOOL_SPECS.map((s) => s.name));
    const bash = bashSpec as ToolSpec;
    for (const allowed of config.worker.allowedTools) {
      if (allowed.startsWith("Bash(")) {
        expect(bash.name).toContain(allowed);
      } else {
        expect(specNames.has(allowed)).toBe(true);
      }
    }
  });

  it("explicitly forbids git push and remote operations", () => {
    const git = findSpec("git");
    expect(git.whenNotToUse).toBeDefined();
    const whenNot = git.whenNotToUse as string;
    expect(whenNot).toContain("push");
    expect(whenNot).toContain("orchestrator-only");
    expect(git.gating).toBe("Blocked by Magnesium (orchestrator only).");
  });

  it("keeps gating notes minimal, not full system messages", () => {
    for (const spec of DEFAULT_TOOL_SPECS) {
      if (spec.gating !== undefined) {
        // A gating note is a short phrase, not a paragraph.
        expect(spec.gating.length).toBeLessThan(120);
      }
    }
  });
});

describe("renderToolGuidance", () => {
  it("returns the empty string for an empty registry", () => {
    expect(renderToolGuidance([])).toBe("");
  });

  it("produces a 'Tool Guidance' heading followed by each spec", () => {
    const out = renderToolGuidance(DEFAULT_TOOL_SPECS);
    expect(out.startsWith("Tool Guidance:")).toBe(true);
    for (const spec of DEFAULT_TOOL_SPECS) {
      expect(out).toContain(spec.name);
      expect(out).toContain(spec.purpose);
      expect(out).toContain(spec.whenToUse);
    }
  });

  it("renders when-NOT and gating lines only when present", () => {
    const out = renderToolGuidance([
      goodSpec,
      { ...goodSpec, name: "Gated", whenNotToUse: "avoid", gating: "blocked" },
    ]);
    expect(out).toContain("Do not use when: avoid");
    expect(out).toContain("Gating: blocked");
    // The bare goodSpec has neither, so its block must not emit those labels
    // for that entry. There is exactly one of each across the two specs.
    expect(out.match(/Do not use when:/g)).toHaveLength(1);
    expect(out.match(/Gating:/g)).toHaveLength(1);
  });

  it("emits no em dashes or en dashes anywhere in the output", () => {
    const out = renderToolGuidance(DEFAULT_TOOL_SPECS);
    expect(out).not.toContain("—"); // em dash
    expect(out).not.toContain("–"); // en dash
  });

  it("is markdown-safe (no code fences or stray control chars)", () => {
    const out = renderToolGuidance(DEFAULT_TOOL_SPECS);
    expect(out).not.toContain("```");
    // No control characters other than the newline separators we emit.
    for (const ch of out) {
      const code = ch.codePointAt(0) ?? 0;
      const isControl = code < 0x20 && ch !== "\n";
      expect(isControl).toBe(false);
    }
  });

  it("renders compactly (one heading line plus a bounded number of lines)", () => {
    const out = renderToolGuidance(DEFAULT_TOOL_SPECS);
    const lineCount = out.split("\n").length;
    // 1 heading + at most 4 lines per spec (name, use, not, gating).
    expect(lineCount).toBeLessThanOrEqual(1 + DEFAULT_TOOL_SPECS.length * 4);
  });
});

describe("prompt-injection positioning (mirrors buildWorkerPrompt)", () => {
  // The integrator appends renderToolGuidance(toolSpecs) after the existing
  // "Rules:" block and before any priorFailure block. This test reproduces
  // that composition locally to lock the intended ordering, without importing
  // or mutating buildWorkerPrompt (which the integrator wires later).
  function composePrompt(opts: { priorFailure?: string }): string {
    const base = [
      "Rules:",
      "- Write the implementation AND its tests in this directory.",
      "- Do not run git. Do not push or force-push.",
    ];
    const guidance = renderToolGuidance(DEFAULT_TOOL_SPECS);
    if (guidance.length > 0) {
      base.push("", guidance);
    }
    if (opts.priorFailure) {
      base.push("", "A previous attempt failed verification.", opts.priorFailure);
    }
    return base.join("\n");
  }

  it("places tool guidance after 'Rules:' and before any priorFailure block", () => {
    const prompt = composePrompt({ priorFailure: "tests failed: foo" });
    const rulesIdx = prompt.indexOf("Rules:");
    const guidanceIdx = prompt.indexOf("Tool Guidance:");
    const failureIdx = prompt.indexOf("A previous attempt failed");
    expect(rulesIdx).toBeGreaterThanOrEqual(0);
    expect(guidanceIdx).toBeGreaterThan(rulesIdx);
    expect(failureIdx).toBeGreaterThan(guidanceIdx);
  });

  it("omits the guidance section cleanly when no specs are supplied", () => {
    const empty = renderToolGuidance([]);
    expect(empty).toBe("");
    // Appending an empty string adds nothing observable to the prompt.
    expect(["Rules:", ...(empty ? [empty] : [])].join("\n")).toBe("Rules:");
  });
});
