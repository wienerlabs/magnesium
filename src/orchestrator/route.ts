import { z } from "zod";

import type { MagnesiumConfig } from "../config/schema";
import type { DagTask } from "../models/schemas";
import type { ModelClient, TokenUsage } from "../models/types";

/**
 * Router-driven triage. After decomposition, the cheap router model validates
 * each task: it confirms the task kind (code / generic / research) and flags or
 * sharpens under-specified acceptance criteria. The result is reconciled against
 * the input by id so the router can never drop, add, or reorder tasks; it can
 * only adjust a task's kind, its acceptance criteria, and attach warnings.
 */
export interface RoutedTask {
  id: string;
  kind: "code" | "generic" | "research";
  acceptanceCriteria: string[];
  warnings: string[];
}

export interface RouteResult {
  tasks: RoutedTask[];
  usage: TokenUsage;
  costUsd: number;
  model: string;
}

const RoutedTaskSchema = z.object({
  id: z.string().min(1).describe("Id of the task being triaged, echoed for traceability"),
  kind: z.enum(["code", "generic", "research"]).describe("Confirmed or corrected task kind"),
  acceptanceCriteria: z
    .array(z.string().min(1))
    .min(1)
    .describe("Concrete, checkable acceptance criteria, sharpened if the original was vague"),
  warnings: z.array(z.string()).describe("Any concerns about scope, ambiguity, or testability"),
});

const RouteOutputSchema = z.object({
  tasks: z.array(RoutedTaskSchema).min(1),
});

const SYSTEM = [
  "You triage a decomposed task list before workers run. For each task, confirm",
  "the kind (code, generic, or research), and make the acceptance criteria",
  "concrete and checkable, sharpening any that are vague. Attach warnings for",
  "scope, ambiguity, or testability concerns. Echo each task's id exactly. Do not",
  "add, drop, merge, or reorder tasks. Return the triaged list via the tool.",
].join(" ");

/**
 * Triage a decomposed task list with the router model. Output is reconciled by
 * id against the input: every input task appears exactly once, in input order,
 * with the router's adjustments applied where present and the original values
 * preserved otherwise.
 */
export async function routeTasks(
  client: ModelClient,
  config: MagnesiumConfig,
  tasks: DagTask[],
): Promise<RouteResult> {
  const user = [
    "Triage these tasks. Return one entry per task, echoing each id.",
    "",
    JSON.stringify(
      tasks.map((t) => ({
        id: t.id,
        kind: t.kind,
        title: t.title,
        description: t.description,
        acceptanceCriteria: t.acceptanceCriteria,
      })),
      null,
      2,
    ),
  ].join("\n");

  const result = await client.structured({
    purpose: "route",
    model: config.models.router,
    system: SYSTEM,
    user,
    schema: RouteOutputSchema,
    schemaName: "task_routing",
    schemaDescription: "Triaged tasks with confirmed kind and sharpened acceptance criteria",
  });

  const byId = new Map(result.value.tasks.map((t) => [t.id, t]));
  const routed: RoutedTask[] = tasks.map((t) => {
    const match = byId.get(t.id);
    const criteria =
      match && match.acceptanceCriteria.length > 0 ? match.acceptanceCriteria : t.acceptanceCriteria;
    return {
      id: t.id,
      kind: match?.kind ?? t.kind,
      acceptanceCriteria: criteria,
      warnings: match?.warnings ?? [],
    };
  });

  return { tasks: routed, usage: result.usage, costUsd: result.costUsd, model: result.model };
}
