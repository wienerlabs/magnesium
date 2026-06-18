import type { Logger } from "../logging/logger";
import type { RunControlRegistry } from "../runtime/run-control";
import type { RunSupervisor } from "./telegram/surface";

/**
 * Daemon-side callback invoked after a resume is requested. The supervisor stays
 * decoupled from engine internals: it flips the run control state to
 * `resume_requested` and then hands the run id back to the daemon so the daemon
 * can re-enter `engine.resume(runId)` on its own. Fire-and-forget by contract;
 * the supervisor does not await its result so a slow or hung daemon resume can
 * never block the control surface that drove the request.
 */
export type OnResume = (runId: string) => void | Promise<void>;

export interface EngineRunSupervisorOptions {
  /** Shared registry the engine loop also reads to honor pause requests. */
  registry: RunControlRegistry;
  /** Daemon hook that re-enters the engine resume path for a run id. */
  onResume: OnResume;
  logger: Logger;
}

/**
 * Concrete {@link RunSupervisor} backed by a {@link RunControlRegistry}.
 *
 * Pause and resume requests from a control surface (Telegram, etc.) are
 * translated into transitions on the per-run {@link RunControl} state machine.
 * The engine loop reads the same registry at a safe point and acts on the
 * cooperative signal. On resume the supervisor additionally invokes the injected
 * `onResume` callback so the daemon can drive `engine.resume` in the background
 * without the supervisor ever reaching into engine internals.
 *
 * Both methods return synchronously after flipping run control state. The
 * `onResume` callback is dispatched fire-and-forget: its promise (if any) is not
 * awaited, and a thrown error or rejected promise is caught and logged rather
 * than propagated to the caller. This keeps the surface layer responsive and the
 * registry state authoritative regardless of how the daemon resume behaves.
 */
export class EngineRunSupervisor implements RunSupervisor {
  private readonly registry: RunControlRegistry;
  private readonly onResume: OnResume;
  private readonly logger: Logger;

  constructor(opts: EngineRunSupervisorOptions) {
    if (typeof opts.onResume !== "function") {
      throw new TypeError("EngineRunSupervisor: onResume must be a function");
    }
    this.registry = opts.registry;
    this.onResume = opts.onResume;
    this.logger = opts.logger;
  }

  requestPause(runId: string): void {
    const control = this.registry.get(runId);
    control.requestPause();
    this.logger.debug({ runId, state: control.state() }, "run pause requested");
  }

  requestResume(runId: string): void {
    const control = this.registry.get(runId);
    control.requestResume();
    this.logger.debug({ runId, state: control.state() }, "run resume requested");
    this.dispatchResume(runId);
  }

  /**
   * Hand the resume off to the daemon without awaiting it. A synchronous throw
   * or a rejected promise is caught and logged so a misbehaving daemon hook can
   * never crash `requestResume` or leave run control state inconsistent.
   */
  private dispatchResume(runId: string): void {
    let result: void | Promise<void>;
    try {
      result = this.onResume(runId);
    } catch (err) {
      this.logger.warn({ runId, err: errMessage(err) }, "onResume threw");
      return;
    }
    if (result instanceof Promise) {
      result.catch((err: unknown) => {
        this.logger.warn({ runId, err: errMessage(err) }, "onResume rejected");
      });
    }
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
