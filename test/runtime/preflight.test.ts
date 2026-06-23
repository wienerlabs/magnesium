import { describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config/load";
import type { MagnesiumConfig } from "../../src/config/schema";
import {
  DefaultProbes,
  formatPreflight,
  runPreflight,
  type PreflightCheck,
  type PreflightProbes,
  type PreflightReport,
  type ProbeOutcome,
} from "../../src/runtime/preflight";

function ok(detail: string): ProbeOutcome {
  return { ok: true, detail };
}

function fail(detail: string): ProbeOutcome {
  return { ok: false, detail };
}

function passingProbes(overrides: Partial<PreflightProbes> = {}): PreflightProbes {
  return {
    env: (name) => (name === "ANTHROPIC_API_KEY" ? "sk-test-key" : undefined),
    dockerInfo: async () => ok("docker server 26.0.0"),
    dockerImage: async () => ok("image magnesium/worker:dev present"),
    gitVersion: async () => ok("git version 2.44.0"),
    ledgerWritable: async () => ok("ledger directory .magnesium is writable"),
    ...overrides,
  };
}

function config(overrides: Partial<MagnesiumConfig> = {}): MagnesiumConfig {
  return { ...loadConfig(), ...overrides };
}

function withContainerEnabled(enabled: boolean): MagnesiumConfig {
  const base = loadConfig();
  return { ...base, container: { ...base.container, enabled } };
}

function checkByName(report: PreflightReport, name: string): PreflightCheck | undefined {
  return report.checks.find((c) => c.name === name);
}

describe("runPreflight", () => {
  it("all checks pass when all probes succeed", async () => {
    const report = await runPreflight(withContainerEnabled(true), passingProbes());
    expect(report.ok).toBe(true);
    expect(report.checks.every((c) => c.ok)).toBe(true);
    expect(checkByName(report, "anthropic api key")?.ok).toBe(true);
    expect(checkByName(report, "container runtime")?.ok).toBe(true);
    expect(checkByName(report, "worker image")?.ok).toBe(true);
    expect(checkByName(report, "git available")?.ok).toBe(true);
    expect(checkByName(report, "ledger directory writable")?.ok).toBe(true);
    expect(checkByName(report, "config parses")?.ok).toBe(true);
  });

  it("ANTHROPIC_API_KEY check fails when env lookup returns undefined", async () => {
    const report = await runPreflight(
      withContainerEnabled(true),
      passingProbes({ env: () => undefined }),
    );
    const check = checkByName(report, "anthropic api key");
    expect(check?.ok).toBe(false);
    expect(check?.remedy).toBeDefined();
    expect(report.ok).toBe(false);
  });

  it("container reachability check is skipped when config.container.enabled is false", async () => {
    const report = await runPreflight(withContainerEnabled(false), passingProbes());
    const runtime = checkByName(report, "container runtime");
    expect(runtime?.ok).toBe(true);
    expect(runtime?.detail).toContain("skipping");
    expect(checkByName(report, "worker image")).toBeUndefined();
    expect(report.ok).toBe(true);
  });

  it("container reachability check fails when docker info command fails", async () => {
    const report = await runPreflight(
      withContainerEnabled(true),
      passingProbes({ dockerInfo: async () => fail("Cannot connect to the Docker daemon") }),
    );
    const runtime = checkByName(report, "container runtime");
    expect(runtime?.ok).toBe(false);
    expect(runtime?.detail).toContain("Docker daemon");
    expect(runtime?.remedy).toBeDefined();
    expect(report.ok).toBe(false);
  });

  it("container image check fails when docker image inspect fails", async () => {
    const report = await runPreflight(
      withContainerEnabled(true),
      passingProbes({ dockerImage: async () => fail("No such image: magnesium/worker:dev") }),
    );
    const image = checkByName(report, "worker image");
    expect(image?.ok).toBe(false);
    expect(image?.detail).toContain("No such image");
    expect(image?.remedy).toBeDefined();
    expect(report.ok).toBe(false);
  });

  it("git availability check fails when git version command fails", async () => {
    const report = await runPreflight(
      withContainerEnabled(true),
      passingProbes({ gitVersion: async () => fail("git: command not found") }),
    );
    const git = checkByName(report, "git available");
    expect(git?.ok).toBe(false);
    expect(git?.remedy).toBeDefined();
    expect(report.ok).toBe(false);
  });

  it("ledger directory check fails when writeability probe throws", async () => {
    const report = await runPreflight(
      withContainerEnabled(true),
      passingProbes({
        ledgerWritable: async () => {
          throw new Error("EACCES: permission denied");
        },
      }),
    );
    const ledger = checkByName(report, "ledger directory writable");
    expect(ledger?.ok).toBe(false);
    expect(ledger?.detail).toContain("EACCES");
    expect(ledger?.remedy).toBeDefined();
    expect(report.ok).toBe(false);
  });

  it("config sanity passes when config is already a valid MagnesiumConfig (no re-parse needed)", async () => {
    const report = await runPreflight(config(), passingProbes());
    const sanity = checkByName(report, "config parses");
    expect(sanity?.ok).toBe(true);
    expect(sanity?.remedy).toBeUndefined();
    expect(sanity?.detail).toContain("config validated");
  });

  it("does not short-circuit: a failing probe still leaves later checks present", async () => {
    const report = await runPreflight(
      withContainerEnabled(true),
      passingProbes({ dockerInfo: async () => fail("daemon down") }),
    );
    expect(checkByName(report, "git available")?.ok).toBe(true);
    expect(checkByName(report, "ledger directory writable")?.ok).toBe(true);
    expect(checkByName(report, "config parses")?.ok).toBe(true);
  });

  it("exposes DefaultProbes with real implementations for every probe", () => {
    expect(typeof DefaultProbes.env).toBe("function");
    expect(typeof DefaultProbes.dockerInfo).toBe("function");
    expect(typeof DefaultProbes.dockerImage).toBe("function");
    expect(typeof DefaultProbes.gitVersion).toBe("function");
    expect(typeof DefaultProbes.ledgerWritable).toBe("function");
  });
});

describe("formatPreflight", () => {
  it("renders all checks with status glyph (checkmark or cross) and detail text", async () => {
    const report = await runPreflight(
      withContainerEnabled(true),
      passingProbes({ gitVersion: async () => fail("git: command not found") }),
    );
    const text = formatPreflight(report);
    expect(text).toContain("[ok] anthropic api key:");
    expect(text).toContain("[xx] git available:");
    expect(text).toContain("git: command not found");
    for (const check of report.checks) {
      expect(text).toContain(check.name);
    }
  });

  it("includes remedy text only when check.remedy is defined", async () => {
    const passText = formatPreflight(
      await runPreflight(withContainerEnabled(true), passingProbes()),
    );
    expect(passText).not.toContain("remedy:");

    const failText = formatPreflight(
      await runPreflight(
        withContainerEnabled(true),
        passingProbes({ env: () => undefined }),
      ),
    );
    expect(failText).toContain("remedy:");
  });

  it("summary line shows overall result (Pass or Fail)", async () => {
    const passText = formatPreflight(
      await runPreflight(withContainerEnabled(true), passingProbes()),
    );
    expect(passText).toContain("result: Pass");

    const failText = formatPreflight(
      await runPreflight(
        withContainerEnabled(true),
        passingProbes({ env: () => undefined }),
      ),
    );
    expect(failText).toContain("result: Fail");
  });

  it("returns plain text with no ANSI color codes (for portability)", async () => {
    const report = await runPreflight(
      withContainerEnabled(true),
      passingProbes({ env: () => undefined, dockerInfo: async () => fail("down") }),
    );
    const text = formatPreflight(report);
    const ansiEscape = String.fromCharCode(27);
    expect(text.includes(ansiEscape)).toBe(false);
  });
});
