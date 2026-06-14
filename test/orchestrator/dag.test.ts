import { describe, expect, it } from "vitest";

import type { TaskStatus } from "../../src/ledger/types";
import { computeReady, detectCycle, topoSort, validateDag } from "../../src/orchestrator/dag";
import { DagValidationError } from "../../src/util/errors";

describe("dag", () => {
  it("accepts a valid acyclic dag", () => {
    expect(() =>
      validateDag([
        { id: "a", dependsOn: [] },
        { id: "b", dependsOn: ["a"] },
      ]),
    ).not.toThrow();
  });

  it("rejects an unknown dependency reference", () => {
    expect(() => validateDag([{ id: "a", dependsOn: ["missing"] }])).toThrow(DagValidationError);
  });

  it("rejects a cycle", () => {
    expect(() =>
      validateDag([
        { id: "a", dependsOn: ["b"] },
        { id: "b", dependsOn: ["a"] },
      ]),
    ).toThrow(DagValidationError);
  });

  it("detects a cycle path", () => {
    const cycle = detectCycle([
      { id: "a", dependsOn: ["b"] },
      { id: "b", dependsOn: ["a"] },
    ]);
    expect(cycle).not.toBeNull();
  });

  it("topologically orders dependencies before dependents", () => {
    const order = topoSort([
      { id: "b", dependsOn: ["a"] },
      { id: "a", dependsOn: [] },
      { id: "c", dependsOn: ["b"] },
    ]);
    expect(order.indexOf("a")).toBeLessThan(order.indexOf("b"));
    expect(order.indexOf("b")).toBeLessThan(order.indexOf("c"));
  });

  it("computes ready and blocked sets from statuses", () => {
    const tasks: { id: string; status: TaskStatus }[] = [
      { id: "a", status: "verified" },
      { id: "f", status: "failed" },
      { id: "b", status: "pending" },
      { id: "c", status: "pending" },
    ];
    const deps = [
      { taskId: "b", dependsOnId: "a" },
      { taskId: "c", dependsOnId: "f" },
    ];
    const { ready, blocked } = computeReady(tasks, deps);
    expect(ready).toEqual(["b"]);
    expect(blocked).toEqual(["c"]);
  });

  it("treats a task with no dependencies as ready", () => {
    const { ready } = computeReady([{ id: "x", status: "pending" }], []);
    expect(ready).toEqual(["x"]);
  });
});
