import type { TaskStatus } from "../ledger/types";
import { DagValidationError } from "../util/errors";

export interface DagNodeInput {
  id: string;
  dependsOn: string[];
}

/** Throws DagValidationError on duplicate ids, unknown dep references, or cycles. */
export function validateDag(nodes: DagNodeInput[]): void {
  const ids = new Set(nodes.map((n) => n.id));
  if (ids.size !== nodes.length) {
    throw new DagValidationError("duplicate task ids in DAG");
  }
  for (const node of nodes) {
    for (const dep of node.dependsOn) {
      if (!ids.has(dep)) {
        throw new DagValidationError(`task ${node.id} depends on unknown task ${dep}`);
      }
    }
  }
  const cycle = detectCycle(nodes);
  if (cycle) {
    throw new DagValidationError(`dependency cycle: ${cycle.join(" -> ")}`);
  }
}

/** Returns a cycle path if one exists, otherwise null. */
export function detectCycle(nodes: DagNodeInput[]): string[] | null {
  const adj = new Map(nodes.map((n) => [n.id, n.dependsOn]));
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  let found: string[] | null = null;

  const dfs = (id: string): boolean => {
    state.set(id, 1);
    stack.push(id);
    for (const dep of adj.get(id) ?? []) {
      const s = state.get(dep) ?? 0;
      if (s === 1) {
        const idx = stack.indexOf(dep);
        found = stack.slice(idx).concat(dep);
        return true;
      }
      if (s === 0 && dfs(dep)) return true;
    }
    stack.pop();
    state.set(id, 2);
    return false;
  };

  for (const node of nodes) {
    if ((state.get(node.id) ?? 0) === 0 && dfs(node.id)) return found;
  }
  return null;
}

/** Topological order, dependencies before dependents. Assumes a valid DAG. */
export function topoSort(nodes: DagNodeInput[]): string[] {
  const inDeg = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const node of nodes) inDeg.set(node.id, node.dependsOn.length);
  for (const node of nodes) {
    for (const dep of node.dependsOn) {
      dependents.set(dep, [...(dependents.get(dep) ?? []), node.id]);
    }
  }
  const queue = nodes.filter((n) => (inDeg.get(n.id) ?? 0) === 0).map((n) => n.id);
  const order: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    order.push(id);
    for (const dependent of dependents.get(id) ?? []) {
      const next = (inDeg.get(dependent) ?? 1) - 1;
      inDeg.set(dependent, next);
      if (next === 0) queue.push(dependent);
    }
  }
  return order;
}

export interface ReadyComputation {
  ready: string[];
  blocked: string[];
}

/**
 * Given current task statuses and dependency edges, partitions pending tasks
 * into those that are ready (all deps verified or integrated) and those that are
 * blocked (a dependency failed, was blocked, or cancelled).
 */
export function computeReady(
  tasks: { id: string; status: TaskStatus }[],
  deps: { taskId: string; dependsOnId: string }[],
): ReadyComputation {
  const statusById = new Map(tasks.map((t) => [t.id, t.status]));
  const depsByTask = new Map<string, string[]>();
  for (const dep of deps) {
    depsByTask.set(dep.taskId, [...(depsByTask.get(dep.taskId) ?? []), dep.dependsOnId]);
  }

  const ready: string[] = [];
  const blocked: string[] = [];
  for (const task of tasks) {
    if (task.status !== "pending") continue;
    const myDeps = depsByTask.get(task.id) ?? [];
    const depStatuses = myDeps.map((id) => statusById.get(id));
    if (depStatuses.some((s) => s === "failed" || s === "blocked" || s === "cancelled")) {
      blocked.push(task.id);
      continue;
    }
    if (depStatuses.every((s) => s === "verified" || s === "integrated")) {
      ready.push(task.id);
    }
  }
  return { ready, blocked };
}
