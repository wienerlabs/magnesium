import type { RunRow, TaskDep, TaskRow } from "../ledger/types";
import type { Logger } from "../logging/logger";
import { shortId } from "../util/ids";
import type { WorkspaceManager } from "../workers/worktree";
import { topoSort } from "./dag";

export interface IntegrationResult {
  integrationBranch: string;
  merged: string[];
  conflicts: { taskId: string; branch: string }[];
  empty: string[];
}

/**
 * Sequentially merges verified task branches into a run integration branch, in
 * topological order. Workers do not commit, so each task's worktree changes are
 * committed onto its branch first. Conflicts are surfaced (not auto-resolved):
 * the merge is aborted and recorded for human attention.
 */
export async function integrateRun(
  wm: WorkspaceManager,
  workspaceDir: string,
  run: RunRow,
  verifiedTasks: TaskRow[],
  deps: TaskDep[],
  baseCommit: string,
  logger: Logger,
): Promise<IntegrationResult> {
  const branch = `magnesium/run-${shortId(run.id)}/integration`;
  await wm.createIntegrationBranch(workspaceDir, branch, baseCommit);

  const idsInSet = new Set(verifiedTasks.map((t) => t.id));
  const order = topoSort(
    verifiedTasks.map((t) => ({
      id: t.id,
      dependsOn: deps
        .filter((d) => d.taskId === t.id && idsInSet.has(d.dependsOnId))
        .map((d) => d.dependsOnId),
    })),
  );
  const byId = new Map(verifiedTasks.map((t) => [t.id, t]));

  const merged: string[] = [];
  const conflicts: { taskId: string; branch: string }[] = [];
  const empty: string[] = [];

  for (const id of order) {
    const task = byId.get(id);
    if (!task || !task.branch) continue;
    if (task.worktreePath) {
      const sha = await wm.commitWorktree(task.worktreePath, `feat(${task.slug}): ${task.title}`);
      if (!sha) empty.push(id);
    }
    const res = await wm.mergeBranch(workspaceDir, task.branch, `merge ${task.slug} (${shortId(id)})`);
    if (res.conflict) {
      conflicts.push({ taskId: id, branch: task.branch });
      logger.warn({ taskId: id, branch: task.branch }, "integration conflict, merge aborted");
    } else {
      merged.push(id);
    }
  }

  return { integrationBranch: branch, merged, conflicts, empty };
}
