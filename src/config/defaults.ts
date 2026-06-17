import type { MagnesiumConfig } from "./schema";

/**
 * Default configuration.
 *
 * Model ids are confirmed against the live environment and the `claude --model`
 * help, not the stale skill table.
 *
 * The `pricing` rates below are PLACEHOLDERS marked VERIFY. They are the one
 * place where wrong numbers would be dangerous, so they are isolated here and
 * never hardcoded in logic. Confirm them against current Anthropic pricing
 * before trusting the dollar figures for direct SDK calls. Worker cost does not
 * depend on this table because Claude Code reports total_cost_usd directly.
 */
export const defaultConfig: MagnesiumConfig = {
  models: {
    orchestrator: "claude-opus-4-8",
    router: "claude-haiku-4-5",
    critic: "claude-haiku-4-5",
    workerDefault: "claude-sonnet-4-6",
    fallback: "claude-haiku-4-5",
    orchestratorThinkingTokens: 8_000,
  },
  budget: {
    capUsd: 5.0,
    perWorkerCapUsd: 1.0,
  },
  // Amendment 4: default to 3 for Phase 1. DoD needs >= 2. Revisit after 429s.
  concurrency: 3,
  worker: {
    maxAttempts: 2,
    timeoutMs: 600_000,
    // Amendment 3: never bypass destructive ops. acceptEdits is the strongest
    // mode that still lets a worker edit files; it never auto-approves
    // arbitrary irreversible operations.
    permissionMode: "acceptEdits",
    // Restrictive allowlist. No git (no push or force-push), no network tools.
    // The container mount already prevents writes outside the worktree; this is
    // defense in depth.
    allowedTools: [
      "Read",
      "Write",
      "Edit",
      "Bash(pnpm:*)",
      "Bash(npm:*)",
      "Bash(npx:*)",
      "Bash(node:*)",
      "Bash(ls:*)",
      "Bash(cat:*)",
      "Bash(grep:*)",
      "Bash(mkdir:*)",
    ],
    // Off by default: ephemeral containers do not persist the session store, so
    // a clean re-run is the safe behavior. Enable only with the local worker or
    // a mounted session volume.
    resumeOnRetry: false,
  },
  container: {
    enabled: true,
    runtime: "orbstack",
    image: "magnesium/worker:dev",
    // Workers need outbound network to reach the Anthropic API.
    network: "bridge",
  },
  verify: {
    testCommand: "pnpm test",
    testTimeoutMs: 300_000,
    // Off by default: the policy critic adds a model call per verify. Enable for
    // runs that produce user-facing content rather than pure internal code.
    policyGate: false,
  },
  paths: {
    ledger: ".magnesium/ledger.db",
    worktrees: ".magnesium/worktrees",
    workspaces: ".magnesium/workspaces",
    logs: ".magnesium/logs",
  },
  pricing: {
    // VERIFY: placeholder rates, USD per million tokens.
    "claude-opus-4-8": {
      inputPerMTok: 15,
      outputPerMTok: 75,
      cacheReadPerMTok: 1.5,
      cacheWritePerMTok: 18.75,
    },
    "claude-sonnet-4-6": {
      inputPerMTok: 3,
      outputPerMTok: 15,
      cacheReadPerMTok: 0.3,
      cacheWritePerMTok: 3.75,
    },
    "claude-haiku-4-5": {
      inputPerMTok: 1,
      outputPerMTok: 5,
      cacheReadPerMTok: 0.1,
      cacheWritePerMTok: 1.25,
    },
    // Fallback when a model id is not in the table. Conservative (Opus rates).
    default: {
      inputPerMTok: 15,
      outputPerMTok: 75,
      cacheReadPerMTok: 1.5,
      cacheWritePerMTok: 18.75,
    },
  },
};
