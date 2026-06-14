import { describe, expect, it } from "vitest";

import type { TaskDep, TaskRow, TaskStatus } from "../../src/ledger/types";
import { renderTaskDag } from "../../src/reporting/dag-render";
import { DagValidationError } from "../../src/util/errors";

function task(id: string, overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id,
    runId: "run-1",
    parentId: null,
    slug: id,
    title: id,
    description: "",
    acceptanceCriteria: [],
    kind: "code",
    status: "pending" as TaskStatus,
    attempt: 0,
    maxAttempts: 2,
    model: null,
    worktreePath: null,
    branch: null,
    workerSessionId: null,
    costUsd: 0,
    resultSummary: null,
    error: null,
    createdAt: "2026-06-14T00:00:00.000Z",
    updatedAt: "2026-06-14T00:00:00.000Z",
    ...overrides,
  };
}

function dep(taskId: string, dependsOnId: string): TaskDep {
  return { taskId, dependsOnId };
}

describe("renderTaskDag", () => {
  it("renders a single task with slug and status", () => {
    const out = renderTaskDag([task("a", { slug: "setup-db", status: "verified" })], []);
    expect(out).toContain("setup-db");
    expect(out).toContain("[verified]");
  });

  it("renders dependency arrows for a linear chain", () => {
    const tasks = [
      task("a", { slug: "first" }),
      task("b", { slug: "second" }),
      task("c", { slug: "third" }),
    ];
    const deps = [dep("b", "a"), dep("c", "b")];
    const out = renderTaskDag(tasks, deps);
    expect(out).toContain("second  ");
    expect(out).toContain("<- first");
    expect(out).toContain("<- second");
    expect(out).toContain("edges:");
    expect(out).toContain("first -> second");
    expect(out).toContain("second -> third");
  });

  it("shows branching for fan-out (one task -> two dependents)", () => {
    const tasks = [task("a", { slug: "root" }), task("b", { slug: "left" }), task("c", { slug: "right" })];
    const deps = [dep("b", "a"), dep("c", "a")];
    const out = renderTaskDag(tasks, deps);
    expect(out).toContain("root -> left");
    expect(out).toContain("root -> right");
  });

  it("shows convergence for fan-in (two tasks -> one dependent)", () => {
    const tasks = [task("a", { slug: "alpha" }), task("b", { slug: "beta" }), task("c", { slug: "merge" })];
    const deps = [dep("c", "a"), dep("c", "b")];
    const out = renderTaskDag(tasks, deps);
    expect(out).toContain("alpha -> merge");
    expect(out).toContain("beta -> merge");
    expect(out).toContain("<- alpha, beta");
  });

  it("includes status glyphs for each status", () => {
    const out = renderTaskDag(
      [
        task("a", { slug: "ok-task", status: "verified" }),
        task("b", { slug: "bad-task", status: "failed" }),
        task("c", { slug: "busy-task", status: "running" }),
        task("d", { slug: "wait-task", status: "pending" }),
      ],
      [],
    );
    expect(out).toContain("ok ");
    expect(out).toContain("X ");
    expect(out).toContain("...");
    expect(out).toContain("- ");
  });

  it("returns an empty string for an empty tasks array", () => {
    expect(renderTaskDag([], [])).toBe("");
  });

  it("displays costUsd per task", () => {
    const out = renderTaskDag([task("a", { slug: "spendy", costUsd: 0.1234 })], []);
    expect(out).toContain("$0.1234");
  });

  it("truncates long slug names", () => {
    const longSlug = "this-is-an-extremely-long-task-slug-that-should-be-truncated";
    const out = renderTaskDag([task("a", { slug: longSlug })], []);
    expect(out).not.toContain(longSlug);
    expect(out).toContain("~");
  });

  it("renders a complex DAG (5+ tasks, mixed deps) without throwing", () => {
    const tasks = [
      task("a", { slug: "a" }),
      task("b", { slug: "b" }),
      task("c", { slug: "c" }),
      task("d", { slug: "d" }),
      task("e", { slug: "e" }),
      task("f", { slug: "f" }),
    ];
    const deps = [dep("b", "a"), dep("c", "a"), dep("d", "b"), dep("d", "c"), dep("e", "d"), dep("f", "e")];
    const out = renderTaskDag(tasks, deps);
    // every task line is rendered, one per task plus header and edges
    for (const id of ["a", "b", "c", "d", "e", "f"]) {
      expect(out).toMatch(new RegExp(`\\b${id} +\\[`));
    }
  });

  it("orders tasks topologically (dependencies before dependents)", () => {
    const tasks = [
      task("c", { slug: "third" }),
      task("a", { slug: "first" }),
      task("b", { slug: "second" }),
    ];
    const deps = [dep("b", "a"), dep("c", "b")];
    const out = renderTaskDag(tasks, deps);
    const lines = out.split("\n");
    const lineOf = (slug: string): number =>
      lines.findIndex((l) => new RegExp(`\\b${slug} +\\[`).test(l));
    const idxFirst = lineOf("first");
    const idxSecond = lineOf("second");
    const idxThird = lineOf("third");
    expect(idxFirst).toBeGreaterThanOrEqual(0);
    expect(idxFirst).toBeLessThan(idxSecond);
    expect(idxSecond).toBeLessThan(idxThird);
  });

  it("rejects a dependency cycle", () => {
    const tasks = [task("a", { slug: "a" }), task("b", { slug: "b" })];
    const deps = [dep("a", "b"), dep("b", "a")];
    expect(() => renderTaskDag(tasks, deps)).toThrow(DagValidationError);
  });

  it("ignores dependency edges that reference unknown tasks", () => {
    const out = renderTaskDag([task("a", { slug: "lonely" })], [dep("a", "ghost")]);
    expect(out).toContain("lonely");
    expect(out).not.toContain("ghost");
  });
});
