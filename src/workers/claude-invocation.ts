import type { MagnesiumConfig } from "../config/schema";
import type { TokenUsage } from "../models/types";
import type { WorkerResult, WorkerTask } from "./worker";

export interface ResultEvent {
  type: "result";
  is_error?: boolean;
  subtype?: string;
  result?: string;
  session_id?: string;
  num_turns?: number;
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

export function buildWorkerPrompt(task: WorkerTask): string {
  const criteria = task.acceptanceCriteria.map((c) => `- ${c}`).join("\n");
  const base = [
    "You are an autonomous worker running inside an isolated git worktree, which",
    "is your current working directory. Implement exactly the task below and",
    "nothing else.",
    "",
    `Task: ${task.title}`,
    "",
    task.description,
    "",
    "Acceptance criteria:",
    criteria,
    "",
    "Rules:",
    "- Write the implementation AND its tests in this directory.",
    "- Do not modify files outside this directory.",
    "- Do not run git. Do not push or force-push.",
    "- Keep changes minimal and focused on the task.",
  ];
  if (task.priorFailure) {
    base.push(
      "",
      "A previous attempt failed verification. Fix the problems described below:",
      task.priorFailure,
    );
  }
  return base.join("\n");
}

/**
 * Builds the claude CLI argv for a worker. `--bare` forces ANTHROPIC_API_KEY
 * auth (API billing, amendment 1) and never reads subscription OAuth or the
 * keychain. permissionMode never bypasses destructive ops (amendment 3).
 * --allowedTools is placed last because it is variadic.
 */
export function buildClaudeArgs(
  task: WorkerTask,
  config: MagnesiumConfig,
  workdir: string,
): string[] {
  return [
    "-p",
    buildWorkerPrompt(task),
    "--bare",
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    task.model,
    "--permission-mode",
    config.worker.permissionMode,
    "--max-budget-usd",
    String(config.budget.perWorkerCapUsd),
    "--fallback-model",
    config.models.fallback,
    "--add-dir",
    workdir,
    "--allowedTools",
    ...config.worker.allowedTools,
  ];
}

/**
 * Wraps the claude invocation in a container run. The worktree is bind-mounted
 * at /work and is the only writable host path. ANTHROPIC_API_KEY is passed
 * through from the host env (there is no keychain in the container, so auth is
 * strictly the API key). Signals sent to `docker run` are forwarded to the
 * container, which is how the supervisor SIGTERMs an in-flight worker.
 */
export function buildContainerInvocation(
  task: WorkerTask,
  config: MagnesiumConfig,
  containerName: string,
): { command: string; args: string[] } {
  const claudeArgs = buildClaudeArgs(task, config, "/work");
  const args = [
    "run",
    "--rm",
    "--init",
    "--name",
    containerName,
    "-v",
    `${task.worktreePath}:/work`,
    "-w",
    "/work",
    "-e",
    "ANTHROPIC_API_KEY",
    "--network",
    config.container.network,
    config.container.image,
    "claude",
    ...claudeArgs,
  ];
  // OrbStack and Docker both expose the standard `docker` CLI.
  return { command: "docker", args };
}

export function parseResultEvent(line: string): ResultEvent | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const obj = JSON.parse(trimmed) as { type?: string };
    if (obj.type === "result") return obj as ResultEvent;
  } catch {
    // Not a complete JSON object on this line; ignore.
  }
  return null;
}

function mapUsage(u: ResultEvent["usage"]): TokenUsage {
  return {
    inputTokens: u?.input_tokens ?? 0,
    outputTokens: u?.output_tokens ?? 0,
    cacheReadTokens: u?.cache_read_input_tokens ?? 0,
    cacheCreationTokens: u?.cache_creation_input_tokens ?? 0,
  };
}

export interface ExecInfo {
  code: number | null;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
}

export function mapWorkerResult(event: ResultEvent | null, info: ExecInfo): WorkerResult {
  if (!event) {
    const reason = info.timedOut
      ? "worker timed out"
      : info.aborted
        ? "worker aborted (budget or supervisor)"
        : `worker exited ${info.code} without a result event: ${info.stderr.trim().slice(0, 500)}`;
    return { ok: false, costUsd: 0, error: reason };
  }
  const ok = event.is_error !== true;
  const result: WorkerResult = {
    ok,
    costUsd: event.total_cost_usd ?? 0,
  };
  if (event.session_id !== undefined) result.sessionId = event.session_id;
  if (event.usage !== undefined) result.usage = mapUsage(event.usage);
  if (event.num_turns !== undefined) result.numTurns = event.num_turns;
  if (event.result !== undefined) result.summary = event.result;
  if (!ok) result.error = event.result ?? event.subtype ?? "worker reported an error";
  return result;
}
