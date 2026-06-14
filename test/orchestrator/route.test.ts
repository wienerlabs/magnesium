import { describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config/load";
import { routeTasks } from "../../src/orchestrator/route";
import { StubModelClient } from "../fixtures/stub-model";

const config = loadConfig();

const tasks = [
  { id: "a", title: "A", description: "da", acceptanceCriteria: ["x"], kind: "code" as const, dependsOn: [] as string[] },
  { id: "b", title: "B", description: "db", acceptanceCriteria: ["y"], kind: "generic" as const, dependsOn: ["a"] },
];

describe("routeTasks", () => {
  it("reconciles router output by id and preserves input order", async () => {
    const client = new StubModelClient({
      route: {
        tasks: [
          { id: "b", kind: "research", acceptanceCriteria: ["y, sharpened"], warnings: ["was vague"] },
          { id: "a", kind: "code", acceptanceCriteria: ["x"], warnings: [] },
        ],
      },
    });
    const res = await routeTasks(client, config, tasks);
    expect(res.tasks.map((t) => t.id)).toEqual(["a", "b"]);
    expect(res.tasks[1]?.kind).toBe("research");
    expect(res.tasks[1]?.acceptanceCriteria).toEqual(["y, sharpened"]);
    expect(res.tasks[1]?.warnings).toContain("was vague");
    expect(client.calls[0]?.model).toBe(config.models.router);
  });

  it("falls back to the original task when the router omits one", async () => {
    const client = new StubModelClient({
      route: { tasks: [{ id: "a", kind: "code", acceptanceCriteria: ["x"], warnings: [] }] },
    });
    const res = await routeTasks(client, config, tasks);
    expect(res.tasks).toHaveLength(2);
    expect(res.tasks[1]?.kind).toBe("generic");
    expect(res.tasks[1]?.acceptanceCriteria).toEqual(["y"]);
  });
});
