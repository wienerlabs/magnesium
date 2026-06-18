/**
 * Cooperative run control (Phase 3 control plane).
 *
 * A run executes inside the engine loop; an operator (via a control surface such
 * as Telegram) may ask it to pause or resume. The engine cannot be preempted
 * mid-task, so control is cooperative: the engine checks `isPauseRequested()` at
 * a safe point in its schedule loop, drains in-flight workers, then marks the run
 * paused. A paused run resumes through the normal engine resume path; this signal
 * just decides when to stop dispatching new work.
 *
 * This is the pinned contract that the engine honors and the supervisor drives.
 * It is deliberately tiny and synchronous so it is trivial to reason about and to
 * test offline.
 */
export type RunControlState = "running" | "pause_requested" | "paused" | "resume_requested";

export interface RunControl {
  /** Ask the run to pause at the next safe point. */
  requestPause(): void;
  /** Ask a paused (or pausing) run to resume. */
  requestResume(): void;
  /** True when a pause has been requested but not yet applied. */
  isPauseRequested(): boolean;
  /** True when a resume has been requested for a paused run. */
  isResumeRequested(): boolean;
  /** The engine calls this once it has drained work and stopped. */
  markPaused(): void;
  /** The engine calls this when it (re)starts the schedule loop. */
  markRunning(): void;
  state(): RunControlState;
}

export class InMemoryRunControl implements RunControl {
  private current: RunControlState = "running";

  requestPause(): void {
    if (this.current === "running" || this.current === "resume_requested") {
      this.current = "pause_requested";
    }
  }

  requestResume(): void {
    if (this.current === "paused" || this.current === "pause_requested") {
      this.current = "resume_requested";
    }
  }

  isPauseRequested(): boolean {
    return this.current === "pause_requested";
  }

  isResumeRequested(): boolean {
    return this.current === "resume_requested";
  }

  markPaused(): void {
    this.current = "paused";
  }

  markRunning(): void {
    this.current = "running";
  }

  state(): RunControlState {
    return this.current;
  }
}

/**
 * One RunControl per run id. The engine and the supervisor share a registry so a
 * pause request from a control surface reaches the engine loop driving that run.
 */
export class RunControlRegistry {
  private readonly controls = new Map<string, RunControl>();

  get(runId: string): RunControl {
    let control = this.controls.get(runId);
    if (!control) {
      control = new InMemoryRunControl();
      this.controls.set(runId, control);
    }
    return control;
  }

  has(runId: string): boolean {
    return this.controls.has(runId);
  }

  remove(runId: string): void {
    this.controls.delete(runId);
  }
}
