import type { TokenUsage } from "../models/types";
import type { ResultEvent } from "./claude-invocation";

export type StreamEventType = "system" | "init" | "assistant" | "user" | "result";

interface RawUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface StreamEvent {
  type: StreamEventType;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  session_id?: string;
  num_turns?: number;
  total_cost_usd?: number;
  usage?: RawUsage;
}

export interface StreamOutcome {
  ok: boolean;
  sessionId?: string;
  result?: string;
  numTurns?: number;
  totalCostUsd: number;
  usage?: TokenUsage;
  errorSubtype?: string;
}

const KNOWN_TYPES: ReadonlySet<string> = new Set([
  "system",
  "init",
  "assistant",
  "user",
  "result",
]);

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function readUsage(value: unknown): RawUsage | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const u = value as Record<string, unknown>;
  const usage: RawUsage = {};
  if (isFiniteNumber(u.input_tokens)) usage.input_tokens = u.input_tokens;
  if (isFiniteNumber(u.output_tokens)) usage.output_tokens = u.output_tokens;
  if (isFiniteNumber(u.cache_read_input_tokens)) {
    usage.cache_read_input_tokens = u.cache_read_input_tokens;
  }
  if (isFiniteNumber(u.cache_creation_input_tokens)) {
    usage.cache_creation_input_tokens = u.cache_creation_input_tokens;
  }
  return usage;
}

/**
 * Parses a single newline-delimited line from `claude -p --output-format
 * stream-json`. Tolerates empty, whitespace-only, non-JSON, and partial or
 * truncated JSON lines by returning null instead of throwing. Lines whose
 * `type` is not one of the known stream event types are ignored (null) so a
 * future CLI event type never crashes the accumulator. This is the robust
 * multi-event counterpart to parseResultEvent, which only recognises the final
 * result event.
 */
export function parseClaudeStreamLine(line: string): StreamEvent | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  if (!trimmed.startsWith("{")) return null;
  let obj: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed !== "object" || parsed === null) return null;
    obj = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const type = obj.type;
  if (typeof type !== "string" || !KNOWN_TYPES.has(type)) return null;

  const event: StreamEvent = { type: type as StreamEventType };
  if (typeof obj.subtype === "string") event.subtype = obj.subtype;
  if (typeof obj.is_error === "boolean") event.is_error = obj.is_error;
  if (typeof obj.result === "string") event.result = obj.result;
  if (typeof obj.session_id === "string") event.session_id = obj.session_id;
  if (isFiniteNumber(obj.num_turns)) event.num_turns = obj.num_turns;
  if (isFiniteNumber(obj.total_cost_usd)) event.total_cost_usd = obj.total_cost_usd;
  const usage = readUsage(obj.usage);
  if (usage !== undefined) event.usage = usage;
  return event;
}

/**
 * Ingests the newline-delimited stream-json events emitted by a worker run and
 * accumulates the cross-event state into a single final outcome. The worker
 * feeds raw lines via processLine (for example from execCommand's onStdoutLine
 * callback); this class performs no I/O of its own. Cost and token usage are
 * summed across every event that reports them, session id and result are taken
 * from the events that carry them, and num_turns is tracked as the running
 * maximum. The accumulator is forgiving: lines that parseClaudeStreamLine
 * cannot turn into a known event are skipped without effect.
 */
export class ClaudeStreamAccumulator {
  private sessionId: string | undefined;
  private result: string | undefined;
  private numTurns: number | undefined;
  private totalCostUsd = 0;
  private usage: TokenUsage | undefined;
  private errorSubtype: string | undefined;
  private sawError = false;
  private sawResult = false;

  /**
   * Feeds one raw line into the accumulator. Returns the parsed event when the
   * line was a recognised stream event, or null when it was ignored (empty,
   * malformed, partial JSON, or an unknown type). A null argument is treated as
   * a no-op, guarding against any caller that forwards an already-null parse.
   */
  processLine(line: string | null): StreamEvent | null {
    if (line === null) return null;
    const event = parseClaudeStreamLine(line);
    if (event === null) return null;
    this.ingest(event);
    return event;
  }

  /** Feeds an already-parsed event, for callers that parse upstream. */
  ingest(event: StreamEvent): void {
    if (this.sessionId === undefined && event.session_id !== undefined) {
      this.sessionId = event.session_id;
    }
    if (event.num_turns !== undefined) {
      this.numTurns =
        this.numTurns === undefined ? event.num_turns : Math.max(this.numTurns, event.num_turns);
    }
    if (event.total_cost_usd !== undefined) {
      this.totalCostUsd += event.total_cost_usd;
    }
    if (event.usage !== undefined) {
      this.mergeUsage(event.usage);
    }
    if (event.type === "result") {
      this.sawResult = true;
      if (event.result !== undefined) this.result = event.result;
      if (event.session_id !== undefined) this.sessionId = event.session_id;
      if (event.is_error === true) {
        this.sawError = true;
        this.errorSubtype = event.subtype ?? this.errorSubtype;
      } else if (event.subtype !== undefined && event.subtype !== "success") {
        this.errorSubtype = event.subtype;
      }
    }
  }

  private mergeUsage(u: RawUsage): void {
    const base = this.usage ?? {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    };
    this.usage = {
      inputTokens: base.inputTokens + (u.input_tokens ?? 0),
      outputTokens: base.outputTokens + (u.output_tokens ?? 0),
      cacheReadTokens: base.cacheReadTokens + (u.cache_read_input_tokens ?? 0),
      cacheCreationTokens: base.cacheCreationTokens + (u.cache_creation_input_tokens ?? 0),
    };
  }

  /** The session id to carry into a verification retry (session-resume opt-in). */
  get resumeSessionId(): string | undefined {
    return this.sessionId;
  }

  /**
   * True once at least one result event has been ingested. A worker stream that
   * ends without a result event (process died, timed out) is a failure, not a
   * zero-cost success, so callers gate on this before trusting the outcome.
   */
  hasResult(): boolean {
    return this.sawResult;
  }

  /**
   * Produces the final outcome. ok is true only when no error was reported and
   * no error subtype was captured. Optional fields are omitted (left undefined)
   * rather than set to empty placeholders so callers can distinguish "absent"
   * from "zero". totalCostUsd always carries a number, defaulting to 0.
   */
  finalOutcome(): StreamOutcome {
    const ok = !this.sawError && this.errorSubtype === undefined;
    const outcome: StreamOutcome = {
      ok,
      totalCostUsd: this.totalCostUsd,
    };
    if (this.sessionId !== undefined) outcome.sessionId = this.sessionId;
    if (this.result !== undefined) outcome.result = this.result;
    if (this.numTurns !== undefined) outcome.numTurns = this.numTurns;
    if (this.usage !== undefined) outcome.usage = this.usage;
    if (this.errorSubtype !== undefined) outcome.errorSubtype = this.errorSubtype;
    return outcome;
  }
}

/**
 * Adapts an accumulated outcome to the legacy ResultEvent shape so existing
 * mapWorkerResult callers can consume the robust accumulator without change.
 * The fields map one for one onto the snake_case event contract.
 */
export function outcomeToResultEvent(outcome: StreamOutcome): ResultEvent {
  const event: ResultEvent = {
    type: "result",
    is_error: !outcome.ok,
    total_cost_usd: outcome.totalCostUsd,
  };
  if (outcome.errorSubtype !== undefined) event.subtype = outcome.errorSubtype;
  if (outcome.result !== undefined) event.result = outcome.result;
  if (outcome.sessionId !== undefined) event.session_id = outcome.sessionId;
  if (outcome.numTurns !== undefined) event.num_turns = outcome.numTurns;
  if (outcome.usage !== undefined) {
    event.usage = {
      input_tokens: outcome.usage.inputTokens,
      output_tokens: outcome.usage.outputTokens,
      cache_read_input_tokens: outcome.usage.cacheReadTokens,
      cache_creation_input_tokens: outcome.usage.cacheCreationTokens,
    };
  }
  return event;
}
