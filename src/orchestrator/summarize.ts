import { z } from "zod";

import type { MagnesiumConfig } from "../config/schema";
import type { TaskRow } from "../ledger/types";
import type { ModelCallResult, ModelClient, TokenUsage } from "../models/types";
import { ZERO_USAGE } from "../models/types";

/**
 * Maximum characters kept by the deterministic fallback summary. The fallback
 * trades fidelity for determinism: it never calls a model, so a resumed run with
 * no ModelClient still produces a stable, bounded digest.
 */
export const FALLBACK_SUMMARY_MAX_CHARS = 200;

/**
 * A single compacted task branch. Mirrors the per-task shape used by the
 * deterministic RunDigest (see compaction.ts) so this module can slot behind the
 * same orchestrator contract: id and slug identify the branch, summary is the
 * compact text that later decisions see instead of a full transcript.
 */
export interface TaskSummary {
  id: string;
  slug: string;
  summary: string;
}

/**
 * Result of summarizing a batch of task branches. Carries the same accounting
 * fields as DecomposeResult and DoneResult (usage, costUsd, model) so the engine
 * can record an LlmCallRow uniformly. When the fallback path runs, usage is zero,
 * costUsd is zero, and model names the fallback marker.
 */
export interface SummarizeResult {
  summaries: TaskSummary[];
  usage: TokenUsage;
  costUsd: number;
  model: string;
}

/** Model marker recorded when the deterministic fallback produced the summaries. */
export const FALLBACK_MODEL = "fallback:deterministic";

/** One task summary as produced by the model, validated before it is trusted. */
export const TaskSummarySchema = z.object({
  id: z.string().min(1).describe("Id of the task being summarized, echoed for traceability"),
  slug: z.string().min(1).describe("Slug of the task being summarized"),
  summary: z
    .string()
    .min(1)
    .describe("One or two sentences capturing what the task accomplished or why it failed"),
});

/** The model's structured response: a non-empty list of per-task summaries. */
export const TaskSummariesSchema = z.object({
  summaries: z.array(TaskSummarySchema).min(1),
  notes: z.string().optional(),
});
export type TaskSummariesOutput = z.infer<typeof TaskSummariesSchema>;

const SYSTEM = [
  "You compact completed and failed task branches of a multi-agent run into",
  "short, faithful summaries. For each task you are given, return exactly one",
  "summary echoing its id and slug, plus one or two sentences describing what the",
  "task produced or why it failed. Do not invent tasks, drop tasks, or change",
  "ids. Return the summaries via the provided tool.",
].join(" ");

/**
 * Thrown when summarization is asked to run over no tasks. The caller decides
 * whether an empty batch is expected (then it should not call this) or a bug.
 */
export class EmptyTaskListError extends Error {
  constructor() {
    super("summarizeTasks requires at least one task");
    this.name = "EmptyTaskListError";
  }
}

/**
 * Deterministic single-task summary: the first FALLBACK_SUMMARY_MAX_CHARS chars
 * of the task description. Whitespace is collapsed first so the bound is on
 * visible content, not formatting. If truncation happens it prefers a word
 * boundary and appends an ellipsis; shorter descriptions are returned verbatim.
 */
export function fallbackSummary(task: Pick<TaskRow, "description">): string {
  const text = task.description.replace(/\s+/g, " ").trim();
  if (text.length <= FALLBACK_SUMMARY_MAX_CHARS) return text;

  const slice = text.slice(0, FALLBACK_SUMMARY_MAX_CHARS);
  const lastSpace = slice.lastIndexOf(" ");
  // Only break at a word boundary when it does not throw away too much of the
  // budget; otherwise hard-truncate so a single long token still gets clipped.
  const cut = lastSpace > FALLBACK_SUMMARY_MAX_CHARS * 0.6 ? slice.slice(0, lastSpace) : slice;
  return `${cut.trimEnd()}...`;
}

/** Builds the full deterministic fallback result for a batch of tasks. */
function fallbackResult(tasks: TaskRow[]): SummarizeResult {
  return {
    summaries: tasks.map((t) => ({ id: t.id, slug: t.slug, summary: fallbackSummary(t) })),
    usage: ZERO_USAGE,
    costUsd: 0,
    model: FALLBACK_MODEL,
  };
}

/**
 * Compacts completed and failed task branches into short per-task summaries.
 *
 * When `client` is null the deterministic fallback runs: zero cost, zero usage,
 * first-N-chars-of-description summaries, in input order. When a client is
 * present it is asked, with purpose "compact", to refine the summaries; the
 * response is schema-validated, then reconciled against the input tasks so the
 * output always has exactly one summary per input task, in input order, with the
 * caller's ids and slugs (a model that drops, reorders, or renames a task cannot
 * corrupt the digest). The model summary text is used when present; otherwise
 * the deterministic fallback fills the gap.
 *
 * Throws EmptyTaskListError on an empty batch: an empty digest is the caller's
 * job to avoid, not something to silently paper over.
 */
export async function summarizeTasks(
  client: ModelClient | null,
  config: MagnesiumConfig,
  tasks: TaskRow[],
): Promise<SummarizeResult> {
  if (tasks.length === 0) throw new EmptyTaskListError();
  if (!client) return fallbackResult(tasks);

  const user = [
    "Summarize these task branches. Return one summary per task, echoing id and slug.",
    "",
    "Tasks:",
    JSON.stringify(
      tasks.map((t) => ({
        id: t.id,
        slug: t.slug,
        title: t.title,
        status: t.status,
        description: t.description,
      })),
      null,
      2,
    ),
  ].join("\n");

  const result: ModelCallResult<TaskSummariesOutput> = await client.structured({
    purpose: "compact",
    model: config.models.router,
    system: SYSTEM,
    user,
    schema: TaskSummariesSchema,
    schemaName: "task_summaries",
    schemaDescription: "Compact summaries of completed and failed task branches",
  });

  const byId = new Map(result.value.summaries.map((s) => [s.id, s]));
  const summaries: TaskSummary[] = tasks.map((t) => {
    const match = byId.get(t.id);
    const summary = match?.summary?.trim();
    return {
      id: t.id,
      slug: t.slug,
      summary: summary && summary.length > 0 ? summary : fallbackSummary(t),
    };
  });

  return {
    summaries,
    usage: result.usage,
    costUsd: result.costUsd,
    model: result.model,
  };
}
