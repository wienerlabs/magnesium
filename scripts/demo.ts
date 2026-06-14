/**
 * End-to-end smoke demo. Requires live credentials and a container runtime:
 *   - ANTHROPIC_API_KEY set (API billing)
 *   - OrbStack (or Docker) running, and `pnpm worker:build` done
 *
 * Runs a hermetic goal in a fresh sandbox repo. The goal is intentionally
 * dependency-free: workers write ESM modules tested with Node's built-in test
 * runner, so verification needs only node, no npm install in the sandbox.
 *
 *   pnpm tsx scripts/demo.ts
 */
import { join } from "node:path";

import { loadConfig } from "../src/config/load";
import { createLogger } from "../src/logging/logger";
import { createEngine } from "../src/runtime/bootstrap";
import { uuid } from "../src/util/ids";

const GOAL = [
  "Create two independent, fully tested modules in this directory using ONLY",
  "Node's built-in test runner (node:test) and node:assert, with no external",
  "dependencies:",
  "1. A file slugify.mjs with `export function slugify(input)` that lowercases",
  "   the input, replaces runs of non-alphanumeric characters with a single",
  "   hyphen, and trims leading and trailing hyphens. Add slugify.test.mjs.",
  "2. A file parse-duration.mjs with `export function parseDuration(input)` that",
  "   converts strings like '1h30m', '45s', and '2h' into milliseconds. Add",
  "   parse-duration.test.mjs.",
  "Every test file must use node:test and node:assert and must pass when run",
  "with `node --test`.",
].join("\n");

async function main(): Promise<void> {
  // node --test is zero-dependency and runs against the worktree files directly.
  const config = loadConfig({ verify: { testCommand: "node --test", testTimeoutMs: 120_000 } });
  const logger = createLogger({ pretty: true });
  const workspaceDir = join(process.cwd(), config.paths.workspaces, `demo-${uuid()}`);
  const { engine, ledger } = createEngine(config, logger);
  try {
    const run = engine.createRun(GOAL, workspaceDir);
    logger.info({ runId: run.id, workspaceDir }, "demo run started");
    const final = await engine.execute(run.id);
    logger.info(
      { runId: run.id, status: final.status, spentUsd: final.costUsdSpent },
      "demo run finished",
    );
    process.exitCode = final.status === "completed" ? 0 : 1;
  } finally {
    ledger.close();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
