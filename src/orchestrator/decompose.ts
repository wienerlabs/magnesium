import type { MagnesiumConfig } from "../config/schema";
import { TaskDagSchema, type TaskDagOutput } from "../models/schemas";
import type { ModelClient, TokenUsage } from "../models/types";
import { validateDag } from "./dag";

const SYSTEM = [
  "You are the orchestrator of a multi-agent engineering system. Decompose the",
  "user's goal into a minimal task DAG that parallel workers can execute. Each",
  "task must be independently executable by a coding agent inside its own git",
  "worktree, with clear, checkable acceptance criteria. Prefer few, well-scoped,",
  "parallelizable tasks. Add a dependency only when a task genuinely needs",
  "another task's output. For code tasks, require that the worker also writes",
  "tests. Return the DAG via the provided tool.",
].join(" ");

export interface DecomposeResult {
  dag: TaskDagOutput;
  usage: TokenUsage;
  costUsd: number;
  model: string;
}

/**
 * Goal to validated task DAG, via the orchestrator model with extended thinking.
 * The output is schema-validated and checked for acyclicity before it is trusted.
 */
export async function decompose(
  client: ModelClient,
  config: MagnesiumConfig,
  goal: string,
): Promise<DecomposeResult> {
  const { value, usage, costUsd, model } = await client.structured({
    purpose: "decompose",
    model: config.models.orchestrator,
    system: SYSTEM,
    user: `Goal:\n${goal}`,
    schema: TaskDagSchema,
    schemaName: "task_dag",
    schemaDescription: "The decomposed task DAG",
    thinkingTokens: config.models.orchestratorThinkingTokens,
  });

  validateDag(value.tasks.map((t) => ({ id: t.id, dependsOn: t.dependsOn })));
  return { dag: value, usage, costUsd, model };
}
