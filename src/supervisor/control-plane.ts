import type { LedgerRepository } from "../ledger/repository";
import type { Logger } from "../logging/logger";
import { RunControlRegistry } from "../runtime/run-control";
import { EngineRunSupervisor } from "./run-supervisor";
import type { ConfirmableAction } from "./confirmation";
import type { ElicitationRequestInput, ElicitationResponse } from "./elicitation";
import { TelegramElicitationGate } from "./elicitation";
import { TelegramConfirmationGate } from "./telegram/confirmation";
import { TelegramControlSurface } from "./telegram/surface";
import type {
  TelegramCallback,
  TelegramCommand,
  TelegramMessage,
  TelegramTransport,
} from "./telegram/transport";

/**
 * Phase 3: ControlPlane daemon wiring.
 *
 * Composes the three control primitives into one live, lifecycle-managed control
 * plane over a single shared TelegramTransport:
 *  - a TelegramControlSurface for chat commands (status / pause / resume / cost),
 *  - a TelegramConfirmationGate for irreversible-action approvals,
 *  - a TelegramElicitationGate for structured ask_user_input requests.
 *
 * The plane owns a RunControlRegistry. A pause/resume command from chat routes
 * through the surface's RunSupervisor seam (implemented here as an
 * EngineRunSupervisor) into the registry, where the engine loop polls it at a
 * safe point. A resume additionally re-enters the engine through an injected
 * resume callback so a paused run actually starts dispatching work again.
 *
 * The engine dependency is kept behind the tiny EngineRunControl interface
 * (resume only) so the whole plane is testable offline with a recording stub: no
 * grammy, no Anthropic API, no Docker, no network.
 */

/**
 * The only seam the ControlPlane needs onto the engine: re-enter a paused run so
 * it resumes dispatching work. Injected so tests can supply a recording stub.
 * resume(runId) is expected to be idempotent on the engine side; the plane never
 * calls it twice for one resume command.
 */
export interface EngineRunControl {
  /** Re-enter the engine schedule loop for a paused run. */
  resume(runId: string): Promise<void>;
}

export interface ControlPlaneOptions {
  /** Shared ledger; the surface reads run status from it. */
  ledger: LedgerRepository;
  /** Shared transport; surface and both gates ride on this one connection. */
  transport: TelegramTransport;
  /** Engine seam used to re-enter a run on resume. */
  engine: EngineRunControl;
  logger: Logger;
  /**
   * Shared run-control registry. The engine loop and this plane must share one
   * instance so a pause request reaches the loop driving that run. Defaults to a
   * fresh registry when the caller does not pre-create one.
   */
  registry?: RunControlRegistry;
  /** Default run targeted by run-scoped commands that omit an id. */
  defaultRunId?: string;
  /** Override the gate pending-request timeout. Defaults to the gate default. */
  gateTimeoutMs?: number;
}

/**
 * Callback fan-out over a single TelegramTransport.
 *
 * The underlying transport (mock or grammy) holds a single onCallback handler:
 * the last registration wins. The confirmation gate and the elicitation gate
 * each register an onCallback handler, so they cannot both ride a raw transport
 * without one clobbering the other. This wrapper multiplexes: it registers one
 * real handler on the underlying transport and fans every inbound callback out
 * to all subscribers. Each gate parses only its own payload shape and ignores
 * the rest, so fan-out is safe and the two gates interleave correctly.
 *
 * sendMessage and onCommand pass straight through; the surface keeps its single
 * onCommand handler on the underlying transport unchanged.
 */
class FanOutTransport implements TelegramTransport {
  private readonly handlers = new Set<
    (callback: TelegramCallback) => void | Promise<void>
  >();
  private rootUnsubscribe?: () => void;

  constructor(
    private readonly inner: TelegramTransport,
    private readonly logger: Logger,
  ) {}

  sendMessage(message: TelegramMessage): Promise<void> {
    return this.inner.sendMessage(message);
  }

  onCommand(handler: (command: TelegramCommand) => void | Promise<void>): () => void {
    return this.inner.onCommand(handler);
  }

  onCallback(handler: (callback: TelegramCallback) => void | Promise<void>): () => void {
    this.handlers.add(handler);
    // Lazily attach the single real handler on first subscription.
    if (!this.rootUnsubscribe) {
      this.rootUnsubscribe = this.inner.onCallback((cb) => this.dispatch(cb));
    }
    return () => {
      this.handlers.delete(handler);
      // Detach the real handler once nobody is listening, so a fully-stopped
      // plane leaves no callback subscription behind on the transport.
      if (this.handlers.size === 0 && this.rootUnsubscribe) {
        this.rootUnsubscribe();
        this.rootUnsubscribe = undefined;
      }
    };
  }

  private dispatch(cb: TelegramCallback): void {
    // Snapshot first: a handler may unsubscribe (e.g. gate.close) while settling.
    for (const handler of [...this.handlers]) {
      try {
        const out = handler(cb);
        if (out && typeof out.then === "function") {
          Promise.resolve(out).catch((err) => {
            const msg = err instanceof Error ? err.message : String(err);
            this.logger.warn({ err: msg }, "callback handler rejected");
          });
        }
      } catch (err) {
        // One misbehaving gate must never block the others or crash the dispatch.
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn({ err: msg }, "callback handler threw");
      }
    }
  }
}

/**
 * The live control plane. Construct it with a shared transport, a ledger, an
 * engine seam, and a logger; call start() to begin listening and stop() (or
 * close()) to tear everything down.
 */
export class ControlPlane {
  readonly registry: RunControlRegistry;
  private readonly logger: Logger;
  private readonly fanOut: FanOutTransport;
  private readonly surface: TelegramControlSurface;
  private readonly supervisor: EngineRunSupervisor;
  private readonly engine: EngineRunControl;
  private readonly confirmationGate: TelegramConfirmationGate;
  private readonly elicitationGate: TelegramElicitationGate;
  private started = false;
  private stopped = false;

  constructor(opts: ControlPlaneOptions) {
    this.logger = opts.logger;
    this.engine = opts.engine;
    this.registry = opts.registry ?? new RunControlRegistry();

    // The two gates share a fan-out wrapper so both receive every callback. The
    // surface rides the fan-out too (its onCommand passes straight through to the
    // underlying transport), keeping one transport instance across the plane.
    this.fanOut = new FanOutTransport(opts.transport, this.logger);

    // Public, tested supervisor. onResume is fire-and-forget so a /resume chat
    // command returns immediately rather than blocking for the whole resumed run.
    // Return the resume promise so the supervisor's fire-and-forget dispatch can
    // attach a .catch; a failed re-entry is logged, never an unhandled rejection.
    this.supervisor = new EngineRunSupervisor({
      registry: this.registry,
      onResume: (runId) => this.engine.resume(runId),
      logger: this.logger,
    });

    this.surface = new TelegramControlSurface({
      ledger: opts.ledger,
      transport: this.fanOut,
      supervisor: this.supervisor,
      logger: this.logger,
      defaultRunId: opts.defaultRunId,
    });

    this.confirmationGate = new TelegramConfirmationGate({
      transport: this.fanOut,
      logger: this.logger,
      timeoutMs: opts.gateTimeoutMs,
    });

    this.elicitationGate = new TelegramElicitationGate({
      transport: this.fanOut,
      logger: this.logger,
      timeoutMs: opts.gateTimeoutMs,
    });
  }

  /**
   * Begin listening for chat commands and gate callbacks. Idempotent: a second
   * start() is a no-op. The gates already subscribed in their constructors, so
   * start() only needs to wire the command surface; it is kept explicit so the
   * plane has a single, obvious lifecycle entry point.
   */
  start(): void {
    if (this.stopped) {
      throw new Error("control plane has been stopped and cannot be restarted");
    }
    if (this.started) return;
    this.started = true;
    this.surface.start();
    this.logger.info("control plane started");
  }

  /**
   * Stop listening and deny every pending confirmation and elicitation. The
   * gates' close() clears their timers and unsubscribes from the fan-out, which
   * detaches the single underlying callback handler once both gates are gone.
   * Idempotent and terminal: a stopped plane cannot be restarted.
   */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.surface.stop();
    // close() denies all in-flight gate requests and clears their timers.
    this.confirmationGate.close();
    this.elicitationGate.close();
    this.logger.info("control plane stopped");
  }

  /** Alias for stop(); mirrors the gates' close() vocabulary. */
  close(): void {
    this.stop();
  }

  // Direct control API (used by the engine / CLI, not just chat) --------------

  /**
   * Request a run pause programmatically. Equivalent to a /pause chat command:
   * sets the cooperative pause flag the engine loop polls.
   */
  requestPause(runId: string): void {
    this.supervisor.requestPause(runId);
  }

  /**
   * Resume a run programmatically. Equivalent to a /resume chat command: marks
   * the run resume_requested and re-enters the engine via the injected callback.
   */
  async resume(runId: string): Promise<void> {
    await this.supervisor.requestResume(runId);
  }

  /** Run an action through the confirmation gate (approve/deny in chat). */
  confirm(action: ConfirmableAction): Promise<boolean> {
    return this.confirmationGate.confirm(action);
  }

  /** Gather structured input through the elicitation gate (inline buttons). */
  elicit(request: ElicitationRequestInput): Promise<ElicitationResponse> {
    return this.elicitationGate.elicit(request);
  }

  // Accessors (handy for the CLI / tests; the plane owns these instances) ------

  get controlSurface(): TelegramControlSurface {
    return this.surface;
  }

  get confirmation(): TelegramConfirmationGate {
    return this.confirmationGate;
  }

  get elicitation(): TelegramElicitationGate {
    return this.elicitationGate;
  }
}
