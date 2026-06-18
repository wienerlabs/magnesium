import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createLogger } from "../../src/logging/logger";
import { RunControlRegistry } from "../../src/runtime/run-control";
import {
  EngineRunSupervisor,
  type EngineRunSupervisorOptions,
  type OnResume,
} from "../../src/supervisor/run-supervisor";

const logger = createLogger({ level: "silent" });

let registry: RunControlRegistry;
let resumed: string[];

beforeEach(() => {
  registry = new RunControlRegistry();
  resumed = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

function build(onResume: OnResume = (id) => void resumed.push(id)): EngineRunSupervisor {
  const opts: EngineRunSupervisorOptions = { registry, onResume, logger };
  return new EngineRunSupervisor(opts);
}

/** Drive any queued microtasks (fire-and-forget onResume promises). */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("EngineRunSupervisor", () => {
  it("constructs against a registry and onResume callback", () => {
    const supervisor = build();
    expect(supervisor).toBeInstanceOf(EngineRunSupervisor);
  });

  it("requestPause transitions run control to pause_requested", () => {
    const supervisor = build();
    supervisor.requestPause("run-1");
    expect(registry.get("run-1").state()).toBe("pause_requested");
  });

  it("requestResume on a paused run transitions to resume_requested", () => {
    const supervisor = build();
    const control = registry.get("run-1");
    control.requestPause();
    control.markPaused();
    expect(control.state()).toBe("paused");

    supervisor.requestResume("run-1");
    expect(control.state()).toBe("resume_requested");
  });

  it("requestResume invokes onResume exactly once per call", () => {
    const onResume = vi.fn<OnResume>();
    const supervisor = build(onResume);
    supervisor.requestResume("run-1");
    supervisor.requestResume("run-1");
    expect(onResume).toHaveBeenCalledTimes(2);
  });

  it("onResume receives the correct runId", () => {
    const supervisor = build();
    supervisor.requestResume("run-abc");
    expect(resumed).toEqual(["run-abc"]);
  });

  it("a thrown onResume does not crash requestResume", () => {
    const supervisor = build(() => {
      throw new Error("daemon resume blew up");
    });
    expect(() => supervisor.requestResume("run-1")).not.toThrow();
    // Run control state remains authoritative despite the failed callback.
    const control = registry.get("run-1");
    control.requestPause();
    control.markPaused();
    supervisor.requestResume("run-1");
    expect(control.state()).toBe("resume_requested");
  });

  it("a rejected async onResume does not crash requestResume", async () => {
    const supervisor = build(async () => {
      throw new Error("async daemon failure");
    });
    expect(() => supervisor.requestResume("run-1")).not.toThrow();
    // Let the rejected promise settle; the supervisor swallows it.
    await flush();
    await expect(Promise.resolve()).resolves.toBeUndefined();
  });

  it("an async onResume runs fire-and-forget without blocking the caller", async () => {
    const order: string[] = [];
    const supervisor = build(async (id) => {
      order.push(`resume-start:${id}`);
      await Promise.resolve();
      order.push(`resume-end:${id}`);
    });
    supervisor.requestResume("run-1");
    // Caller returns before the async resume finishes its later turns.
    order.push("after-request");
    await flush();
    expect(order[order.length - 1]).toBe("resume-end:run-1");
    expect(order).toContain("after-request");
  });

  it("keeps independent state for multiple concurrent runs", () => {
    const supervisor = build();
    supervisor.requestPause("run-a");

    const b = registry.get("run-b");
    b.requestPause();
    b.markPaused();
    supervisor.requestResume("run-b");

    expect(registry.get("run-a").state()).toBe("pause_requested");
    expect(registry.get("run-b").state()).toBe("resume_requested");
    expect(resumed).toEqual(["run-b"]);
  });

  it("requestPause is idempotent and safe to call repeatedly", () => {
    const supervisor = build();
    supervisor.requestPause("run-1");
    supervisor.requestPause("run-1");
    supervisor.requestPause("run-1");
    expect(registry.get("run-1").state()).toBe("pause_requested");
  });

  it("requestResume is idempotent on a paused run", () => {
    const onResume = vi.fn<OnResume>();
    const supervisor = build(onResume);
    const control = registry.get("run-1");
    control.requestPause();
    control.markPaused();

    supervisor.requestResume("run-1");
    supervisor.requestResume("run-1");
    expect(control.state()).toBe("resume_requested");
    // The callback fires per call even though the state is unchanged.
    expect(onResume).toHaveBeenCalledTimes(2);
  });

  it("registry.get creates a new control on first access via the supervisor", () => {
    const supervisor = build();
    expect(registry.has("run-new")).toBe(false);
    supervisor.requestPause("run-new");
    expect(registry.has("run-new")).toBe(true);
  });

  it("does not auto-remove registry entries (manual lifecycle)", () => {
    const supervisor = build();
    supervisor.requestPause("run-1");
    const control = registry.get("run-1");
    control.markPaused();
    supervisor.requestResume("run-1");
    control.markRunning();
    // Entry persists until the daemon explicitly removes it.
    expect(registry.has("run-1")).toBe(true);
    registry.remove("run-1");
    expect(registry.has("run-1")).toBe(false);
  });

  it("full pause flow: running -> pause_requested -> paused", () => {
    const supervisor = build();
    const control = registry.get("run-1");
    expect(control.state()).toBe("running");
    supervisor.requestPause("run-1");
    expect(control.state()).toBe("pause_requested");
    control.markPaused();
    expect(control.state()).toBe("paused");
  });

  it("full resume flow: paused -> resume_requested -> running", () => {
    const supervisor = build();
    const control = registry.get("run-1");
    control.requestPause();
    control.markPaused();
    supervisor.requestResume("run-1");
    expect(control.state()).toBe("resume_requested");
    control.markRunning();
    expect(control.state()).toBe("running");
  });

  it("requestResume on a running run is a safe no-op per RunControl contract", () => {
    const onResume = vi.fn<OnResume>();
    const supervisor = build(onResume);
    const control = registry.get("run-1");
    expect(control.state()).toBe("running");
    supervisor.requestResume("run-1");
    // RunControl ignores resume from running, but the daemon hook still fires.
    expect(control.state()).toBe("running");
    expect(onResume).toHaveBeenCalledWith("run-1");
  });

  it("throws if onResume is not a function", () => {
    expect(
      () =>
        new EngineRunSupervisor({
          registry,
          // @ts-expect-error intentional bad option for runtime guard test
          onResume: undefined,
          logger,
        }),
    ).toThrow(TypeError);
    expect(
      () =>
        new EngineRunSupervisor({
          registry,
          // @ts-expect-error intentional bad option for runtime guard test
          onResume: "not-a-fn",
          logger,
        }),
    ).toThrow(/onResume must be a function/);
  });

  it("logs debug events for pause and resume transitions", () => {
    const debug = vi.spyOn(logger, "debug");
    const supervisor = build();
    supervisor.requestPause("run-1");
    supervisor.requestResume("run-1");
    const messages = debug.mock.calls.map((c) => c[c.length - 1]);
    expect(messages).toContain("run pause requested");
    expect(messages).toContain("run resume requested");
  });

  it("logs a warning when onResume throws", () => {
    const warn = vi.spyOn(logger, "warn");
    const supervisor = build(() => {
      throw new Error("boom");
    });
    supervisor.requestResume("run-1");
    const messages = warn.mock.calls.map((c) => c[c.length - 1]);
    expect(messages).toContain("onResume threw");
  });

  it("logs a warning when an async onResume rejects", async () => {
    const warn = vi.spyOn(logger, "warn");
    const supervisor = build(async () => {
      throw new Error("async boom");
    });
    supervisor.requestResume("run-1");
    await flush();
    const messages = warn.mock.calls.map((c) => c[c.length - 1]);
    expect(messages).toContain("onResume rejected");
  });
});
