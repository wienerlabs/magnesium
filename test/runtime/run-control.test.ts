import { describe, expect, it } from "vitest";

import { InMemoryRunControl, RunControlRegistry } from "../../src/runtime/run-control";

describe("InMemoryRunControl", () => {
  it("starts in the running state", () => {
    const control = new InMemoryRunControl();
    expect(control.state()).toBe("running");
  });

  it("requestPause() moves running to pause_requested", () => {
    const control = new InMemoryRunControl();
    control.requestPause();
    expect(control.state()).toBe("pause_requested");
  });

  it("requestPause() moves resume_requested back to pause_requested", () => {
    const control = new InMemoryRunControl();
    // Reach resume_requested via paused.
    control.requestPause();
    control.markPaused();
    control.requestResume();
    expect(control.state()).toBe("resume_requested");

    control.requestPause();
    expect(control.state()).toBe("pause_requested");
  });

  it("requestPause() is idempotent while already pause_requested", () => {
    const control = new InMemoryRunControl();
    control.requestPause();
    control.requestPause();
    expect(control.state()).toBe("pause_requested");
    expect(control.isPauseRequested()).toBe(true);
  });

  it("requestPause() is a no-op once paused", () => {
    const control = new InMemoryRunControl();
    control.requestPause();
    control.markPaused();
    expect(control.state()).toBe("paused");

    control.requestPause();
    expect(control.state()).toBe("paused");
  });

  it("markPaused() moves pause_requested to paused", () => {
    const control = new InMemoryRunControl();
    control.requestPause();
    control.markPaused();
    expect(control.state()).toBe("paused");
  });

  it("markPaused() forces paused even when not pause_requested", () => {
    // markPaused is the engine telling the registry it has stopped; it is
    // unconditional in the pinned contract, so calling it from running lands
    // in paused. This documents that the engine, not the state guard, decides.
    const control = new InMemoryRunControl();
    expect(control.state()).toBe("running");
    control.markPaused();
    expect(control.state()).toBe("paused");
  });

  it("requestResume() moves paused to resume_requested", () => {
    const control = new InMemoryRunControl();
    control.requestPause();
    control.markPaused();
    control.requestResume();
    expect(control.state()).toBe("resume_requested");
  });

  it("requestResume() moves pause_requested to resume_requested", () => {
    const control = new InMemoryRunControl();
    control.requestPause();
    expect(control.state()).toBe("pause_requested");

    control.requestResume();
    expect(control.state()).toBe("resume_requested");
  });

  it("requestResume() is a no-op while running", () => {
    const control = new InMemoryRunControl();
    expect(control.state()).toBe("running");
    control.requestResume();
    expect(control.state()).toBe("running");
  });

  it("requestResume() is idempotent while already resume_requested", () => {
    const control = new InMemoryRunControl();
    control.requestPause();
    control.markPaused();
    control.requestResume();
    control.requestResume();
    expect(control.state()).toBe("resume_requested");
    expect(control.isResumeRequested()).toBe(true);
  });

  it("markRunning() moves resume_requested to running", () => {
    const control = new InMemoryRunControl();
    control.requestPause();
    control.markPaused();
    control.requestResume();
    control.markRunning();
    expect(control.state()).toBe("running");
  });

  it("markRunning() forces running even when not resume_requested", () => {
    // Like markPaused, markRunning is unconditional: the engine asserts it has
    // (re)started the loop regardless of the prior signal state.
    const control = new InMemoryRunControl();
    control.requestPause();
    expect(control.state()).toBe("pause_requested");
    control.markRunning();
    expect(control.state()).toBe("running");
  });

  it("isPauseRequested() is true only in pause_requested", () => {
    const control = new InMemoryRunControl();
    expect(control.isPauseRequested()).toBe(false); // running

    control.requestPause();
    expect(control.isPauseRequested()).toBe(true); // pause_requested

    control.markPaused();
    expect(control.isPauseRequested()).toBe(false); // paused

    control.requestResume();
    expect(control.isPauseRequested()).toBe(false); // resume_requested

    control.markRunning();
    expect(control.isPauseRequested()).toBe(false); // running
  });

  it("isResumeRequested() is true only in resume_requested", () => {
    const control = new InMemoryRunControl();
    expect(control.isResumeRequested()).toBe(false); // running

    control.requestPause();
    expect(control.isResumeRequested()).toBe(false); // pause_requested

    control.markPaused();
    expect(control.isResumeRequested()).toBe(false); // paused

    control.requestResume();
    expect(control.isResumeRequested()).toBe(true); // resume_requested

    control.markRunning();
    expect(control.isResumeRequested()).toBe(false); // running
  });

  it("state() reflects the current state at each transition", () => {
    const control = new InMemoryRunControl();
    const seen: string[] = [control.state()];

    control.requestPause();
    seen.push(control.state());
    control.markPaused();
    seen.push(control.state());
    control.requestResume();
    seen.push(control.state());
    control.markRunning();
    seen.push(control.state());

    expect(seen).toEqual([
      "running",
      "pause_requested",
      "paused",
      "resume_requested",
      "running",
    ]);
  });

  it("drives the full pause and resume cycle in order", () => {
    const control = new InMemoryRunControl();

    expect(control.state()).toBe("running");

    // Operator asks to pause.
    control.requestPause();
    expect(control.isPauseRequested()).toBe(true);
    expect(control.state()).toBe("pause_requested");

    // Engine drains work and stops.
    control.markPaused();
    expect(control.isPauseRequested()).toBe(false);
    expect(control.state()).toBe("paused");

    // Operator asks to resume.
    control.requestResume();
    expect(control.isResumeRequested()).toBe(true);
    expect(control.state()).toBe("resume_requested");

    // Engine restarts the schedule loop.
    control.markRunning();
    expect(control.isResumeRequested()).toBe(false);
    expect(control.state()).toBe("running");
  });

  it("pause-while-pausing keeps a single pause_requested signal", () => {
    const control = new InMemoryRunControl();
    control.requestPause();
    control.requestPause();
    control.requestPause();
    expect(control.state()).toBe("pause_requested");
    expect(control.isPauseRequested()).toBe(true);
  });

  it("resume-while-running stays running with no resume signal", () => {
    const control = new InMemoryRunControl();
    control.requestResume();
    control.requestResume();
    expect(control.state()).toBe("running");
    expect(control.isResumeRequested()).toBe(false);
  });

  it("escapes pause_requested back to resume_requested without ever marking paused", () => {
    // An operator can cancel a pending pause before the engine drains work:
    // requestResume from pause_requested goes straight to resume_requested,
    // so the run never actually parks in paused.
    const control = new InMemoryRunControl();
    control.requestPause();
    expect(control.state()).toBe("pause_requested");

    control.requestResume();
    expect(control.state()).toBe("resume_requested");
    expect(control.isResumeRequested()).toBe(true);

    control.markRunning();
    expect(control.state()).toBe("running");
  });
});

describe("RunControlRegistry", () => {
  it("get() lazily creates an InMemoryRunControl in the running state", () => {
    const registry = new RunControlRegistry();
    const control = registry.get("run-1");
    expect(control).toBeInstanceOf(InMemoryRunControl);
    expect(control.state()).toBe("running");
  });

  it("get() returns the same instance for the same runId", () => {
    const registry = new RunControlRegistry();
    const first = registry.get("run-1");
    const second = registry.get("run-1");
    expect(second).toBe(first);
  });

  it("preserves state across repeated get() calls for the same runId", () => {
    const registry = new RunControlRegistry();
    registry.get("run-1").requestPause();
    expect(registry.get("run-1").state()).toBe("pause_requested");
    expect(registry.get("run-1").isPauseRequested()).toBe(true);
  });

  it("has() is false before the first get()", () => {
    const registry = new RunControlRegistry();
    expect(registry.has("run-1")).toBe(false);
  });

  it("has() is true after get() creates the control", () => {
    const registry = new RunControlRegistry();
    registry.get("run-1");
    expect(registry.has("run-1")).toBe(true);
  });

  it("remove() deletes the control from the registry", () => {
    const registry = new RunControlRegistry();
    registry.get("run-1");
    expect(registry.has("run-1")).toBe(true);

    registry.remove("run-1");
    expect(registry.has("run-1")).toBe(false);
  });

  it("remove() is idempotent for an unknown runId", () => {
    const registry = new RunControlRegistry();
    expect(() => registry.remove("never-existed")).not.toThrow();
    registry.get("run-1");
    registry.remove("run-1");
    registry.remove("run-1");
    expect(registry.has("run-1")).toBe(false);
  });

  it("get() after remove() creates a fresh instance in the running state", () => {
    const registry = new RunControlRegistry();
    const original = registry.get("run-1");
    original.requestPause();
    original.markPaused();
    expect(original.state()).toBe("paused");

    registry.remove("run-1");
    const recreated = registry.get("run-1");

    expect(recreated).not.toBe(original);
    expect(recreated.state()).toBe("running");
  });

  it("keeps controls for different runIds independent", () => {
    const registry = new RunControlRegistry();
    const a = registry.get("run-a");
    const b = registry.get("run-b");

    expect(a).not.toBe(b);

    a.requestPause();
    expect(a.state()).toBe("pause_requested");
    expect(b.state()).toBe("running");
    expect(b.isPauseRequested()).toBe(false);
  });

  it("does not let operations on different runIds interfere", () => {
    const registry = new RunControlRegistry();
    const a = registry.get("run-a");
    const b = registry.get("run-b");
    const c = registry.get("run-c");

    // Park a, hold b at pause_requested, leave c running.
    a.requestPause();
    a.markPaused();
    b.requestPause();

    expect(a.state()).toBe("paused");
    expect(b.state()).toBe("pause_requested");
    expect(c.state()).toBe("running");

    // Resume a, drive b to resume_requested, pause c.
    a.requestResume();
    b.requestResume();
    c.requestPause();

    expect(a.state()).toBe("resume_requested");
    expect(b.state()).toBe("resume_requested");
    expect(c.state()).toBe("pause_requested");

    // Removing one runId leaves the others untouched.
    registry.remove("run-b");
    expect(registry.has("run-a")).toBe(true);
    expect(registry.has("run-b")).toBe(false);
    expect(registry.has("run-c")).toBe(true);
    expect(registry.get("run-a").state()).toBe("resume_requested");
    expect(registry.get("run-c").state()).toBe("pause_requested");
  });

  it("isolates two registry instances from each other", () => {
    const first = new RunControlRegistry();
    const second = new RunControlRegistry();

    first.get("shared-id").requestPause();

    expect(first.has("shared-id")).toBe(true);
    expect(second.has("shared-id")).toBe(false);
    expect(second.get("shared-id").state()).toBe("running");
  });
});
