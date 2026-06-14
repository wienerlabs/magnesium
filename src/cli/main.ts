import { join, resolve } from "node:path";

import { Command } from "commander";

import { loadConfig } from "../config/load";
import type { MagnesiumConfig } from "../config/schema";
import type { LedgerRepository } from "../ledger/repository";
import type { RunStatusView } from "../supervisor/control-surface";
import { LedgerControlSurface } from "../supervisor/control-surface";
import { createLogger } from "../logging/logger";
import { createEngine, openLedger } from "../runtime/bootstrap";
import type { RunRow } from "../ledger/types";
import { shortId, uuid } from "../util/ids";

interface RunOptions {
  workspace?: string;
  budget?: string;
  concurrency?: string;
}

function overridesFrom(opts: RunOptions): Partial<MagnesiumConfig> {
  const overrides: Partial<MagnesiumConfig> = {};
  if (opts.budget !== undefined) {
    overrides.budget = { capUsd: Number(opts.budget), perWorkerCapUsd: Number(opts.budget) / 5 };
  }
  if (opts.concurrency !== undefined) {
    overrides.concurrency = Number(opts.concurrency);
  }
  return overrides;
}

function resolveRunId(ledger: LedgerRepository, idOrPrefix: string): string | null {
  if (ledger.getRun(idOrPrefix)) return idOrPrefix;
  const matches = ledger.listRuns().filter((r) => r.id.startsWith(idOrPrefix));
  return matches.length === 1 ? (matches[0] as RunRow).id : null;
}

function printRunResult(run: RunRow): void {
  console.log("");
  console.log(`run ${shortId(run.id)} -> ${run.status}`);
  console.log(`  goal:    ${run.goal}`);
  console.log(`  spent:   $${run.costUsdSpent.toFixed(4)} / $${run.budgetUsdCap.toFixed(2)} cap`);
  if (run.integrationBranch) console.log(`  branch:  ${run.integrationBranch}`);
  console.log(`  id:      ${run.id}`);
}

function printStatus(view: RunStatusView): void {
  const { run, tasks, deps, recentEvents } = view;
  printRunResult(run);
  console.log("");
  console.log("  tasks:");
  for (const t of tasks) {
    const dependsOn = deps
      .filter((d) => d.taskId === t.id)
      .map((d) => shortId(d.dependsOnId))
      .join(",");
    const depCol = dependsOn ? ` deps[${dependsOn}]` : "";
    console.log(
      `    ${shortId(t.id)}  ${t.status.padEnd(11)}  a${t.attempt}/${t.maxAttempts}  ` +
        `$${t.costUsd.toFixed(4)}  ${t.slug}${depCol}`,
    );
  }
  console.log("");
  console.log("  recent events:");
  for (const e of recentEvents) {
    console.log(`    #${e.seq}  ${e.type}${e.taskId ? `  (${shortId(e.taskId)})` : ""}`);
  }
}

async function runCommand(goal: string, opts: RunOptions): Promise<void> {
  const config = loadConfig(overridesFrom(opts));
  const logger = createLogger({ pretty: true });
  const workspaceDir = opts.workspace
    ? resolve(opts.workspace)
    : join(process.cwd(), config.paths.workspaces, uuid());

  const { engine, ledger } = createEngine(config, logger);
  try {
    const run = engine.createRun(goal, workspaceDir);
    console.log(`run ${shortId(run.id)} created (workspace: ${workspaceDir})`);
    const final = await engine.execute(run.id);
    printRunResult(final);
    process.exitCode = final.status === "completed" ? 0 : 1;
  } finally {
    ledger.close();
  }
}

async function resumeCommand(idOrPrefix: string): Promise<void> {
  const config = loadConfig();
  const logger = createLogger({ pretty: true });
  const { engine, ledger } = createEngine(config, logger);
  try {
    const runId = resolveRunId(ledger, idOrPrefix);
    if (!runId) {
      console.error(`no run matching ${idOrPrefix}`);
      process.exitCode = 1;
      return;
    }
    const final = await engine.resume(runId);
    printRunResult(final);
    process.exitCode = final.status === "completed" ? 0 : 1;
  } finally {
    ledger.close();
  }
}

function statusCommand(idOrPrefix: string | undefined): void {
  const config = loadConfig();
  const ledger = openLedger(config);
  try {
    const surface = new LedgerControlSurface(ledger);
    if (!idOrPrefix) {
      const runs = surface.listRuns();
      if (runs.length === 0) {
        console.log("no runs yet");
        return;
      }
      for (const r of runs) {
        console.log(
          `${shortId(r.id)}  ${r.status.padEnd(11)}  $${r.costUsdSpent.toFixed(4)}  ${r.goal.slice(0, 60)}`,
        );
      }
      return;
    }
    const runId = resolveRunId(ledger, idOrPrefix);
    const view = runId ? surface.status(runId) : null;
    if (!view) {
      console.error(`no run matching ${idOrPrefix}`);
      process.exitCode = 1;
      return;
    }
    printStatus(view);
  } finally {
    ledger.close();
  }
}

async function main(): Promise<void> {
  const program = new Command();
  program
    .name("magnesium")
    .description("Self-hosted multi-agent orchestration harness around Claude Opus 4.8")
    .version("0.1.0");

  program
    .command("run")
    .description("Decompose a goal, dispatch workers, verify, and integrate")
    .argument("<goal>", "the goal to accomplish")
    .option("--workspace <dir>", "target git repo (a fresh sandbox repo is created if omitted)")
    .option("--budget <usd>", "hard cost cap for this run")
    .option("--concurrency <n>", "max parallel workers")
    .action(runCommand);

  program
    .command("resume")
    .description("Continue a run after a crash or budget pause")
    .argument("<runId>", "run id or unique prefix")
    .action(resumeCommand);

  program
    .command("status")
    .description("Show runs, or the live DAG for one run")
    .argument("[runId]", "run id or unique prefix")
    .action(statusCommand);

  await program.parseAsync(process.argv);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
