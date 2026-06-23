import { z } from "zod";

import type { Logger } from "../../logging/logger";
import type { TokenUsage } from "../../models/types";
import type { WorkerAdapter, WorkerResult, WorkerTask } from "../worker";
import type { AipDid } from "./aip-did";
import type { AipResolver, ResolverContext } from "./worker-registry";

/**
 * The subset of the global fetch contract this module depends on. Narrowing to a
 * single-argument shape keeps the injected stub small in tests, while the real
 * global fetch satisfies it structurally. The init carries method, headers, the
 * serialized body, and the AbortSignal so an aborted dispatch cancels the
 * in-flight request rather than leaking it.
 */
export interface FetchInit {
  method: string;
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
}

export interface FetchResponse {
  ok: boolean;
  status: number;
  statusText: string;
  json(): Promise<unknown>;
}

export type FetchLike = (url: string, init: FetchInit) => Promise<FetchResponse>;

/**
 * The wire shape a remote worker returns. It mirrors the snake_case result event
 * the claude CLI emits (total_cost_usd, input_tokens, ...) so a remote worker can
 * forward the worker result it already has without re-keying it. The mapping back
 * to the camelCase WorkerResult happens here, at the boundary.
 *
 * costUsd is required and must be a finite non-negative number: a missing or
 * malformed cost is a protocol violation, not a zero, so it fails validation
 * loudly rather than silently under-billing the ledger.
 */
const WireUsageSchema = z.object({
  input_tokens: z.number().nonnegative().optional(),
  output_tokens: z.number().nonnegative().optional(),
  cache_read_input_tokens: z.number().nonnegative().optional(),
  cache_creation_input_tokens: z.number().nonnegative().optional(),
});

const WireResultSchema = z.object({
  ok: z.boolean(),
  total_cost_usd: z.number().nonnegative().finite(),
  session_id: z.string().optional(),
  num_turns: z.number().optional(),
  summary: z.string().optional(),
  error: z.string().optional(),
  usage: WireUsageSchema.optional(),
});

type WireResult = z.infer<typeof WireResultSchema>;
type WireUsage = z.infer<typeof WireUsageSchema>;

function mapUsage(u: WireUsage): TokenUsage {
  return {
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheCreationTokens: u.cache_creation_input_tokens ?? 0,
  };
}

function mapWireResult(wire: WireResult): WorkerResult {
  const result: WorkerResult = { ok: wire.ok, costUsd: wire.total_cost_usd };
  if (wire.session_id !== undefined) result.sessionId = wire.session_id;
  if (wire.num_turns !== undefined) result.numTurns = wire.num_turns;
  if (wire.summary !== undefined) result.summary = wire.summary;
  if (wire.error !== undefined) result.error = wire.error;
  if (wire.usage !== undefined) result.usage = mapUsage(wire.usage);
  return result;
}

/**
 * The task payload POSTed to the remote worker. Only the addressable, transport
 * safe fields are sent: worktreePath, priorFailure, and resumeSessionId are local
 * to the dispatching host and have no meaning on a remote machine, so they are
 * intentionally omitted.
 */
function buildPayload(task: WorkerTask): Record<string, unknown> {
  return {
    runId: task.runId,
    taskId: task.taskId,
    slug: task.slug,
    title: task.title,
    description: task.description,
    acceptanceCriteria: task.acceptanceCriteria,
    kind: task.kind,
    model: task.model,
  };
}

function isAbortError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === "AbortError") return true;
  return err instanceof Error && err.name === "AbortError";
}

export interface HttpResolverOptions {
  /**
   * Injected HTTP client. Defaults to the platform global fetch (Node 22+), but
   * tests pass a stub or a client pointed at a local 127.0.0.1 server so the
   * suite runs fully offline. The default is read lazily at dispatch time, so a
   * test that replaces globalThis.fetch is still honored.
   */
  fetch?: FetchLike;
  /**
   * URL scheme for the dispatch endpoint. Defaults to https. Exposed only so the
   * local-server integration tests can target http on 127.0.0.1; production
   * traffic stays on https.
   */
  scheme?: "http" | "https";
}

/**
 * Resolves the dispatch URL for a worker from its DID. The pattern is
 * {scheme}://{wallet}/aip/{agentId}/dispatch. wallet and agentId come straight
 * from the AipDid, which the registry only produces after the strict
 * AIP_DID_REGEX has matched (wallet is [a-zA-Z0-9]+, agentId is [a-z0-9-]+), so
 * neither segment can carry a slash, a colon, or a scheme prefix. No further
 * escaping is required and protocol confusion is structurally impossible.
 */
function dispatchUrl(did: AipDid, scheme: "http" | "https"): string {
  return `${scheme}://${did.wallet}/aip/${did.agentId}/dispatch`;
}

/**
 * A real (non-loopback) WorkerAdapter that dispatches a task to a remote worker
 * over HTTP. It POSTs the task as JSON to a URL derived from the worker DID,
 * awaits a JSON WorkerResult-shaped response, validates it, and maps it back to a
 * WorkerResult. Every failure mode (already-aborted signal, non-2xx status,
 * network error, abort during the request, malformed response body) is turned
 * into a clear failing WorkerResult (ok:false, error) rather than a thrown
 * exception, so the dispatcher treats a remote failure exactly like a local one.
 */
export class HttpRemoteWorker implements WorkerAdapter {
  private readonly url: string;
  private readonly fetchImpl?: FetchLike;
  private readonly logger?: Logger;

  constructor(did: AipDid, opts: HttpResolverOptions = {}, logger?: Logger) {
    this.url = dispatchUrl(did, opts.scheme ?? "https");
    this.fetchImpl = opts.fetch;
    this.logger = logger;
  }

  async dispatch(task: WorkerTask, signal: AbortSignal): Promise<WorkerResult> {
    if (signal.aborted) {
      return { ok: false, costUsd: 0, error: "aborted before http dispatch" };
    }

    const fetchImpl = this.resolveFetch();
    if (!fetchImpl) {
      return { ok: false, costUsd: 0, error: "no fetch implementation available" };
    }

    this.logger?.info({ taskId: task.taskId, url: this.url }, "dispatching http remote worker");

    let response: FetchResponse;
    try {
      response = await fetchImpl(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(buildPayload(task)),
        signal,
      });
    } catch (err) {
      if (isAbortError(err)) {
        this.logger?.warn({ taskId: task.taskId }, "http remote worker aborted in flight");
        return { ok: false, costUsd: 0, error: "aborted during http dispatch" };
      }
      const msg = err instanceof Error ? err.message : String(err);
      this.logger?.error({ taskId: task.taskId }, "http remote worker network error");
      return { ok: false, costUsd: 0, error: `http dispatch network error: ${msg}` };
    }

    if (!response.ok) {
      this.logger?.error(
        { taskId: task.taskId, status: response.status },
        "http remote worker returned non-2xx",
      );
      return {
        ok: false,
        costUsd: 0,
        error: `http dispatch failed: ${response.status} ${response.statusText}`.trim(),
      };
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (err) {
      if (isAbortError(err)) {
        return { ok: false, costUsd: 0, error: "aborted during http dispatch" };
      }
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, costUsd: 0, error: `http dispatch returned unreadable body: ${msg}` };
    }

    const parsed = WireResultSchema.safeParse(body);
    if (!parsed.success) {
      const detail = parsed.error.issues[0]?.message ?? "invalid";
      this.logger?.error({ taskId: task.taskId }, "http remote worker sent a malformed result");
      return { ok: false, costUsd: 0, error: `http dispatch malformed result: ${detail}` };
    }

    return mapWireResult(parsed.data);
  }

  private resolveFetch(): FetchLike | undefined {
    if (this.fetchImpl) return this.fetchImpl;
    const globalFetch = (globalThis as { fetch?: FetchLike }).fetch;
    return globalFetch;
  }
}

/**
 * Builds an AipResolver that turns any DID into an HttpRemoteWorker. Because the
 * resolver always returns a worker, every DID is treated as a live remote
 * endpoint; the dispatcher's loopback fallback is reserved for the no-DID case.
 * The injected fetch (from opts) flows into every worker the resolver builds,
 * which is what lets the test suite stay fully offline.
 */
export function createHttpAipResolver(opts: HttpResolverOptions = {}): AipResolver {
  return (did: AipDid, ctx: ResolverContext): WorkerAdapter => {
    return new HttpRemoteWorker(did, opts, ctx.logger);
  };
}
