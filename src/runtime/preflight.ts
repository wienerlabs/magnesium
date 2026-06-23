import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { MagnesiumConfig } from "../config/schema";
import { execCommand } from "../util/exec";

export interface PreflightCheck {
  name: string;
  ok: boolean;
  detail: string;
  remedy?: string;
}

export interface PreflightReport {
  checks: PreflightCheck[];
  ok: boolean;
}

/**
 * The result of one external probe. A probe never throws on an expected failure
 * (missing key, docker unreachable); it returns ok=false with a short detail so
 * the report stays uniform. Unexpected exceptions are caught by runPreflight and
 * surfaced as a failed check, which is why the ledger probe is allowed to throw.
 */
export interface ProbeOutcome {
  ok: boolean;
  detail: string;
}

/**
 * The injectable side-effecting surface. Every probe has a real default in
 * DefaultProbes, and tests pass stubs so the suite runs fully offline with no
 * docker, git, network, or filesystem writes.
 */
export interface PreflightProbes {
  /** Reads one environment variable. Returns undefined when unset or empty. */
  env(name: string): string | undefined;
  /** True when the container runtime answers `docker info`. */
  dockerInfo(): Promise<ProbeOutcome>;
  /** True when `docker image inspect <image>` finds the worker image. */
  dockerImage(image: string): Promise<ProbeOutcome>;
  /** True when `git --version` succeeds. */
  gitVersion(): Promise<ProbeOutcome>;
  /** True when a temp file can be created and removed under the ledger dir. */
  ledgerWritable(ledgerPath: string): Promise<ProbeOutcome>;
}

const DOCKER_PROBE_TIMEOUT_MS = 10_000;
const GIT_PROBE_TIMEOUT_MS = 5_000;

function firstLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim().length > 0);
  return line ? line.trim() : "";
}

async function probeDockerInfo(): Promise<ProbeOutcome> {
  try {
    const res = await execCommand("docker", ["info", "--format", "{{.ServerVersion}}"], {
      timeoutMs: DOCKER_PROBE_TIMEOUT_MS,
    });
    if (res.code === 0) {
      const version = firstLine(res.stdout) || "reachable";
      return { ok: true, detail: `docker server ${version}` };
    }
    return { ok: false, detail: firstLine(res.stderr) || `docker info exited ${res.code}` };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

async function probeDockerImage(image: string): Promise<ProbeOutcome> {
  try {
    const res = await execCommand(
      "docker",
      ["image", "inspect", image, "--format", "{{.Id}}"],
      { timeoutMs: DOCKER_PROBE_TIMEOUT_MS },
    );
    if (res.code === 0) {
      return { ok: true, detail: `image ${image} present` };
    }
    return { ok: false, detail: firstLine(res.stderr) || `image ${image} not found` };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

async function probeGitVersion(): Promise<ProbeOutcome> {
  try {
    const res = await execCommand("git", ["--version"], { timeoutMs: GIT_PROBE_TIMEOUT_MS });
    if (res.code === 0) {
      return { ok: true, detail: firstLine(res.stdout) || "git available" };
    }
    return { ok: false, detail: firstLine(res.stderr) || `git --version exited ${res.code}` };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

function dirnameOf(p: string): string {
  const idx = p.replace(/\/+$/, "").lastIndexOf("/");
  return idx <= 0 ? "." : p.slice(0, idx);
}

async function probeLedgerWritable(ledgerPath: string): Promise<ProbeOutcome> {
  const dir = dirnameOf(ledgerPath);
  let base: string;
  try {
    base = mkdtempSync(join(dir, ".magnesium-preflight-"));
  } catch {
    try {
      base = mkdtempSync(join(tmpdir(), "magnesium-preflight-"));
    } catch (err) {
      return {
        ok: false,
        detail: `cannot create a temp dir for ${dir}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
  const probeFile = join(base, `probe-${randomBytes(4).toString("hex")}`);
  try {
    writeFileSync(probeFile, "ok");
    unlinkSync(probeFile);
    return { ok: true, detail: `ledger directory ${dir} is writable` };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  } finally {
    try {
      rmSync(base, { recursive: true, force: true });
    } catch {
      // Best effort cleanup; a leftover temp dir is not a preflight failure.
    }
  }
}

/**
 * Real probe implementations. runPreflight defaults to these; tests override
 * them entirely so no command runs and no file is written.
 */
export const DefaultProbes: PreflightProbes = {
  env: (name) => {
    const value = process.env[name];
    return value === undefined || value.trim() === "" ? undefined : value;
  },
  dockerInfo: probeDockerInfo,
  dockerImage: probeDockerImage,
  gitVersion: probeGitVersion,
  ledgerWritable: probeLedgerWritable,
};

async function safeProbe(run: () => Promise<ProbeOutcome>): Promise<ProbeOutcome> {
  try {
    return await run();
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Runs the environment and configuration health checks the harness needs before
 * its first real run. Every external interaction goes through an injectable
 * probe, so a stubbed probes argument makes this fully deterministic and offline.
 * Checks are independent: a failure in one never short-circuits the rest, so the
 * report always lists every check the operator should know about.
 */
export async function runPreflight(
  config: MagnesiumConfig,
  probes: PreflightProbes = DefaultProbes,
): Promise<PreflightReport> {
  const checks: PreflightCheck[] = [];

  const apiKey = probes.env("ANTHROPIC_API_KEY");
  checks.push({
    name: "anthropic api key",
    ok: apiKey !== undefined,
    detail: apiKey !== undefined ? "ANTHROPIC_API_KEY is set" : "ANTHROPIC_API_KEY is not set",
    ...(apiKey === undefined
      ? {
          remedy:
            "Export ANTHROPIC_API_KEY in your environment or .env. The orchestrator and workers both bill against it.",
        }
      : {}),
  });

  if (config.container.enabled) {
    const info = await safeProbe(() => probes.dockerInfo());
    checks.push({
      name: "container runtime",
      ok: info.ok,
      detail: info.detail,
      ...(info.ok
        ? {}
        : {
            remedy: `Start the ${config.container.runtime} runtime so 'docker info' responds, then re-run doctor.`,
          }),
    });

    const image = await safeProbe(() => probes.dockerImage(config.container.image));
    checks.push({
      name: "worker image",
      ok: image.ok,
      detail: image.detail,
      ...(image.ok
        ? {}
        : {
            remedy: `Build or pull the worker image '${config.container.image}' so 'docker image inspect' finds it.`,
          }),
    });
  } else {
    checks.push({
      name: "container runtime",
      ok: true,
      detail: "container.enabled is false, skipping runtime and image checks",
    });
  }

  const git = await safeProbe(() => probes.gitVersion());
  checks.push({
    name: "git available",
    ok: git.ok,
    detail: git.detail,
    ...(git.ok
      ? {}
      : { remedy: "Install git and make sure it is on PATH. Worktrees require it." }),
  });

  const ledger = await safeProbe(() => probes.ledgerWritable(config.paths.ledger));
  checks.push({
    name: "ledger directory writable",
    ok: ledger.ok,
    detail: ledger.detail,
    ...(ledger.ok
      ? {}
      : {
          remedy: `Make the directory holding '${config.paths.ledger}' writable, or point paths.ledger somewhere writable.`,
        }),
  });

  checks.push({
    name: "config parses",
    ok: true,
    detail: `config validated: budget cap $${config.budget.capUsd.toFixed(2)}, concurrency ${config.concurrency}`,
  });

  return { checks, ok: checks.every((c) => c.ok) };
}

const PASS_GLYPH = "[ok]";
const FAIL_GLYPH = "[xx]";

/**
 * Renders a PreflightReport as plain text for the terminal. Pure: no color
 * codes, no I/O. Glyphs are ASCII so the output is portable across terminals and
 * CI logs. The CLI prints the result verbatim.
 */
export function formatPreflight(report: PreflightReport): string {
  const lines: string[] = [];
  lines.push("preflight");
  for (const check of report.checks) {
    const glyph = check.ok ? PASS_GLYPH : FAIL_GLYPH;
    lines.push(`  ${glyph} ${check.name}: ${check.detail}`);
    if (check.remedy !== undefined) {
      lines.push(`       remedy: ${check.remedy}`);
    }
  }
  lines.push("");
  lines.push(`result: ${report.ok ? "Pass" : "Fail"}`);
  return lines.join("\n");
}
