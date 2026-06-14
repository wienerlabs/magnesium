import { describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config/load";
import type { TaskRow } from "../../src/ledger/types";
import { computeCostUsd } from "../../src/models/cost";
import type { ModelCallResult, ModelClient, StructuredRequest } from "../../src/models/types";
import {
  EmptyTaskListError,
  FALLBACK_MODEL,
  FALLBACK_SUMMARY_MAX_CHARS,
  fallbackSummary,
  summarizeTasks,
} from "../../src/orchestrator/summarize";
import { StubModelClient } from "../fixtures/stub-model";

const config = loadConfig();

function task(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id: "t-1",
    runId: "run-1",
    parentId: null,
    slug: "task-one",
    title: "Task One",
    description: "Implement the first thing and write tests for it.",
    acceptanceCriteria: ["it works"],
    kind: "code",
    status: "verified",
    attempt: 1,
    maxAttempts: 2,
    model: null,
    worktreePath: null,
    branch: null,
    workerSessionId: null,
    costUsd: 0,
    resultSummary: null,
    error: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/**
 * A ModelClient that returns non-zero usage and a config-priced cost, so tests
 * can assert that cost accounting flows through (the shared StubModelClient
 * always reports zero). The response is still validated through req.schema.
 */
class PricedModelClient implements ModelClient {
  public readonly calls: StructuredRequest<unknown>[] = [];

  constructor(
    private readonly responses: Record<string, unknown>,
    private readonly pricing: Record<string, import("../../src/config/schema").PriceRate>,
    private readonly usage = {
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    },
  ) {}

  async structured<T>(req: StructuredRequest<T>): Promise<ModelCallResult<T>> {
    this.calls.push(req as StructuredRequest<unknown>);
    const raw = this.responses[req.purpose];
    if (raw === undefined) throw new Error(`no response for purpose "${req.purpose}"`);
    const value = req.schema.parse(raw);
    const costUsd = computeCostUsd(req.model, this.usage, this.pricing);
    return { value, usage: this.usage, costUsd, model: req.model };
  }
}

describe("fallbackSummary", () => {
  it("preserves exact text if description is shorter than the limit", () => {
    const t = task({ description: "short and sweet" });
    expect(fallbackSummary(t)).toBe("short and sweet");
  });

  it("returns first N chars with an ellipsis when the description is longer", () => {
    const long = "word ".repeat(100).trim();
    const out = fallbackSummary(t(long));
    expect(out.endsWith("...")).toBe(true);
    // The visible content (sans ellipsis) never exceeds the budget.
    expect(out.length - 3).toBeLessThanOrEqual(FALLBACK_SUMMARY_MAX_CHARS);
  });

  it("truncates at a word boundary when one is available", () => {
    const long = "alpha ".repeat(100).trim();
    const out = fallbackSummary(t(long));
    // No partial trailing word before the ellipsis: it ends on a whole "alpha".
    expect(out).toMatch(/alpha\.\.\.$/);
  });

  it("hard-truncates a single very long token with no usable word boundary", () => {
    const out = fallbackSummary(t("x".repeat(500)));
    expect(out).toBe("x".repeat(FALLBACK_SUMMARY_MAX_CHARS) + "...");
  });

  it("collapses whitespace before measuring length", () => {
    const out = fallbackSummary(t("a\n\n   b\t\tc"));
    expect(out).toBe("a b c");
  });
});

function t(description: string): TaskRow {
  return task({ description });
}

describe("summarizeTasks (fallback path)", () => {
  it("falls back to deterministic summaries when client is null", async () => {
    const tasks = [
      task({ id: "a", slug: "task-a", description: "build a" }),
      task({ id: "b", slug: "task-b", description: "build b" }),
    ];
    const res = await summarizeTasks(null, config, tasks);
    expect(res.summaries).toEqual([
      { id: "a", slug: "task-a", summary: "build a" },
      { id: "b", slug: "task-b", summary: "build b" },
    ]);
  });

  it("reports zero cost and zero usage on the fallback path", async () => {
    const res = await summarizeTasks(null, config, [task()]);
    expect(res.costUsd).toBe(0);
    expect(res.usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
    expect(res.model).toBe(FALLBACK_MODEL);
  });

  it("throws EmptyTaskListError on an empty task list", async () => {
    await expect(summarizeTasks(null, config, [])).rejects.toBeInstanceOf(EmptyTaskListError);
    const client = new StubModelClient({ compact: { summaries: [{ id: "x", slug: "x", summary: "y" }] } });
    await expect(summarizeTasks(client, config, [])).rejects.toBeInstanceOf(EmptyTaskListError);
  });
});

describe("summarizeTasks (model path)", () => {
  it("returns summaries keyed by task id when a ModelClient is available", async () => {
    const tasks = [
      task({ id: "a", slug: "task-a" }),
      task({ id: "b", slug: "task-b" }),
    ];
    const client = new StubModelClient({
      compact: {
        summaries: [
          { id: "a", slug: "task-a", summary: "did a" },
          { id: "b", slug: "task-b", summary: "did b" },
        ],
      },
    });
    const res = await summarizeTasks(client, config, tasks);
    const byId = Object.fromEntries(res.summaries.map((s) => [s.id, s.summary]));
    expect(byId).toEqual({ a: "did a", b: "did b" });
  });

  it("calls the router model with the 'compact' purpose", async () => {
    const client = new StubModelClient({
      compact: { summaries: [{ id: "t-1", slug: "task-one", summary: "ok" }] },
    });
    await summarizeTasks(client, config, [task()]);
    expect(client.calls[0]?.purpose).toBe("compact");
    expect(client.calls[0]?.model).toBe(config.models.router);
  });

  it("includes task ids in the request user content for traceability", async () => {
    const client = new PricedModelClient(
      { compact: { summaries: [{ id: "t-1", slug: "task-one", summary: "ok" }] } },
      config.pricing,
    );
    await summarizeTasks(client, config, [task({ id: "t-1", description: "do work" })]);
    expect(client.calls[0]?.user).toContain("t-1");
    expect(client.calls[0]?.user).toContain("task-one");
  });

  it("preserves task ordering in the output regardless of model order", async () => {
    const tasks = [
      task({ id: "a", slug: "task-a" }),
      task({ id: "b", slug: "task-b" }),
      task({ id: "c", slug: "task-c" }),
    ];
    // Model returns them shuffled; output must follow input order.
    const client = new StubModelClient({
      compact: {
        summaries: [
          { id: "c", slug: "task-c", summary: "did c" },
          { id: "a", slug: "task-a", summary: "did a" },
          { id: "b", slug: "task-b", summary: "did b" },
        ],
      },
    });
    const res = await summarizeTasks(client, config, tasks);
    expect(res.summaries.map((s) => s.id)).toEqual(["a", "b", "c"]);
    expect(res.summaries.map((s) => s.summary)).toEqual(["did a", "did b", "did c"]);
  });

  it("fills missing model summaries from the deterministic fallback", async () => {
    const tasks = [
      task({ id: "a", slug: "task-a", description: "build a" }),
      task({ id: "b", slug: "task-b", description: "build b" }),
    ];
    // Model only summarized "a"; "b" must fall back to its description.
    const client = new StubModelClient({
      compact: { summaries: [{ id: "a", slug: "task-a", summary: "did a" }] },
    });
    const res = await summarizeTasks(client, config, tasks);
    expect(res.summaries).toEqual([
      { id: "a", slug: "task-a", summary: "did a" },
      { id: "b", slug: "task-b", summary: "build b" },
    ]);
  });

  it("rejects a schema-invalid response from the ModelClient", async () => {
    // Empty summaries array violates the min(1) constraint.
    const client = new StubModelClient({ compact: { summaries: [] } });
    await expect(summarizeTasks(client, config, [task()])).rejects.toBeTruthy();
  });

  it("rejects a response missing a required field", async () => {
    const client = new StubModelClient({ compact: { summaries: [{ id: "t-1", summary: "ok" }] } });
    await expect(summarizeTasks(client, config, [task()])).rejects.toBeTruthy();
  });

  it("returns zero cost and zero usage with the shared StubModelClient", async () => {
    const client = new StubModelClient({
      compact: { summaries: [{ id: "t-1", slug: "task-one", summary: "ok" }] },
    });
    const res = await summarizeTasks(client, config, [task()]);
    expect(res.costUsd).toBe(0);
    expect(res.usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
  });

  it("propagates usage and a router-priced cost from the model result", async () => {
    const usage = { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheCreationTokens: 0 };
    const client = new PricedModelClient(
      { compact: { summaries: [{ id: "t-1", slug: "task-one", summary: "ok" }] } },
      config.pricing,
      usage,
    );
    const res = await summarizeTasks(client, config, [task()]);
    expect(res.model).toBe(config.models.router);
    expect(res.usage).toEqual(usage);
    const expected = computeCostUsd(config.models.router, usage, config.pricing);
    expect(res.costUsd).toBeCloseTo(expected, 12);
    // Sanity: the router model is priced, so cost is strictly positive here.
    expect(res.costUsd).toBeGreaterThan(0);
  });
});
