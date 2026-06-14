import type { TaskDep, TaskRow, TaskStatus } from "../ledger/types";
import { detectCycle, topoSort } from "../orchestrator/dag";
import { DagValidationError } from "../util/errors";

/**
 * Render a task DAG (tasks + dependencies + statuses) as ASCII art for terminal
 * display. Pure: takes ledger rows, returns a multiline string. No I/O.
 *
 * Output is one line per task in topological order (dependencies before
 * dependents), with a status glyph, slug, cost, and the slugs of the tasks it
 * depends on. A trailing edge list makes the structure explicit for fan-out and
 * fan-in shapes that a single column cannot show directly.
 */

export interface TaskDagNode {
  id: string;
  slug: string;
  status: TaskStatus;
  dependsOn: string[];
  costUsd: number;
}

const MAX_SLUG = 28;

/** Unicode status glyphs. ASCII-safe fallbacks live in STATUS_GLYPH_ASCII. */
const STATUS_GLYPH: Record<TaskStatus, string> = {
  pending: "-",
  ready: "*",
  dispatched: ">",
  running: "...",
  verifying: "?",
  verified: "ok",
  integrated: "++",
  failed: "X",
  blocked: "#",
  cancelled: "~",
};

function glyph(status: TaskStatus): string {
  return STATUS_GLYPH[status] ?? "-";
}

function truncate(slug: string): string {
  if (slug.length <= MAX_SLUG) return slug;
  // Keep the slug readable; mark truncation with a trailing tilde, no em dash.
  return `${slug.slice(0, MAX_SLUG - 1)}~`;
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

/**
 * Build the renderable node list from raw ledger rows. Dependency edges are
 * collapsed to the dependsOn array per task. Rejects cycles with a
 * DagValidationError so callers never render a nonsensical graph.
 */
export function buildDagNodes(tasks: TaskRow[], deps: TaskDep[]): TaskDagNode[] {
  const dependsByTask = new Map<string, string[]>();
  for (const dep of deps) {
    dependsByTask.set(dep.taskId, [...(dependsByTask.get(dep.taskId) ?? []), dep.dependsOnId]);
  }
  const known = new Set(tasks.map((t) => t.id));
  // Only keep edges whose endpoints are both present, so a stray dep row cannot
  // crash topo ordering.
  const nodeInputs = tasks.map((t) => ({
    id: t.id,
    dependsOn: (dependsByTask.get(t.id) ?? []).filter((d) => known.has(d)),
  }));
  const cycle = detectCycle(nodeInputs);
  if (cycle) {
    throw new DagValidationError(`dependency cycle: ${cycle.join(" -> ")}`);
  }
  return tasks.map((t) => ({
    id: t.id,
    slug: t.slug,
    status: t.status,
    dependsOn: dependsByTask.get(t.id)?.filter((d) => known.has(d)) ?? [],
    costUsd: t.costUsd,
  }));
}

/**
 * Render tasks + deps + statuses. Empty tasks array yields "". Throws
 * DagValidationError if the dependency edges contain a cycle.
 */
export function renderTaskDag(tasks: TaskRow[], deps: TaskDep[]): string {
  if (tasks.length === 0) return "";

  const nodes = buildDagNodes(tasks, deps);
  const byId = new Map(nodes.map((n) => [n.id, n]));

  const ordered = topoSort(nodes.map((n) => ({ id: n.id, dependsOn: n.dependsOn })));
  // Fall back to insertion order for any node topoSort could not place.
  const seen = new Set(ordered);
  for (const node of nodes) if (!seen.has(node.id)) ordered.push(node.id);

  const slugOf = (id: string): string => truncate(byId.get(id)?.slug ?? id);
  const slugWidth = Math.max(4, ...nodes.map((n) => truncate(n.slug).length));

  const lines: string[] = [];
  lines.push("task dag");
  for (const id of ordered) {
    const node = byId.get(id);
    if (!node) continue;
    const depCol =
      node.dependsOn.length > 0 ? `  <- ${node.dependsOn.map(slugOf).join(", ")}` : "";
    lines.push(
      `  ${pad(glyph(node.status), 3)} ${pad(truncate(node.slug), slugWidth)}  ` +
        `[${node.status}]  $${node.costUsd.toFixed(4)}${depCol}`,
    );
  }

  // Explicit edge list so fan-out and fan-in are unambiguous in plain text.
  const edges = nodes.flatMap((n) => n.dependsOn.map((d) => ({ from: d, to: n.id })));
  if (edges.length > 0) {
    lines.push("  edges:");
    for (const edge of edges) {
      lines.push(`    ${slugOf(edge.from)} -> ${slugOf(edge.to)}`);
    }
  }

  return lines.join("\n");
}
