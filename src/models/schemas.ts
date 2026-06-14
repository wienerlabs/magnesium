import { z } from "zod";

/** A task as proposed by the orchestrator during decomposition. */
export const DagTaskSchema = z.object({
  id: z
    .string()
    .min(1)
    .describe("Stable local id for this task, referenced by dependsOn of other tasks"),
  title: z.string().min(1),
  description: z.string().min(1).describe("What the worker must do, self-contained"),
  acceptanceCriteria: z
    .array(z.string().min(1))
    .min(1)
    .describe("Concrete, checkable criteria the result must satisfy"),
  kind: z.enum(["code", "generic", "research"]),
  dependsOn: z
    .array(z.string())
    .describe("Local ids of tasks that must complete before this one"),
  suggestedModel: z.string().optional(),
});
export type DagTask = z.infer<typeof DagTaskSchema>;

export const TaskDagSchema = z.object({
  tasks: z.array(DagTaskSchema).min(1),
  notes: z.string().optional(),
});
export type TaskDagOutput = z.infer<typeof TaskDagSchema>;

/** The orchestrator's judgement on whether the run satisfied the goal. */
export const DoneDecisionSchema = z.object({
  done: z.boolean(),
  reason: z.string().min(1),
  remainingWork: z.array(z.string()).optional(),
});
export type DoneDecision = z.infer<typeof DoneDecisionSchema>;

/** A critic verdict for generic (non-code) verification. */
export const CriticVerdictSchema = z.object({
  pass: z.boolean(),
  confidence: z.number().min(0).max(1),
  reasons: z.array(z.string()).min(1),
});
export type CriticVerdict = z.infer<typeof CriticVerdictSchema>;
