import { describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config/load";
import { decompose } from "../../src/orchestrator/decompose";
import { DagValidationError } from "../../src/util/errors";
import { StubModelClient } from "../fixtures/stub-model";

const config = loadConfig();

describe("decompose", () => {
  it("returns a schema-validated DAG and calls the orchestrator model", async () => {
    const client = new StubModelClient({
      decompose: {
        tasks: [
          { id: "a", title: "A", description: "do a", acceptanceCriteria: ["a done"], kind: "code", dependsOn: [] },
          { id: "b", title: "B", description: "do b", acceptanceCriteria: ["b done"], kind: "code", dependsOn: ["a"] },
        ],
      },
    });
    const res = await decompose(client, config, "build two modules");
    expect(res.dag.tasks).toHaveLength(2);
    expect(client.calls[0]?.purpose).toBe("decompose");
    expect(client.calls[0]?.model).toBe(config.models.orchestrator);
  });

  it("rejects a cyclic DAG from the model", async () => {
    const client = new StubModelClient({
      decompose: {
        tasks: [
          { id: "a", title: "A", description: "x", acceptanceCriteria: ["x"], kind: "code", dependsOn: ["b"] },
          { id: "b", title: "B", description: "y", acceptanceCriteria: ["y"], kind: "code", dependsOn: ["a"] },
        ],
      },
    });
    await expect(decompose(client, config, "goal")).rejects.toBeInstanceOf(DagValidationError);
  });
});
