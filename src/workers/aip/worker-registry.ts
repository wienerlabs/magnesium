import type { Logger } from "../../logging/logger";
import type { MagnesiumConfig } from "../../config/schema";
import type { WorkerAdapter } from "../worker";
import { AipDidSchema, type AipDid } from "./aip-did";

/** Reason a DID could not be turned into a worker adapter. */
export type DidResolutionCode = "INVALID_DID" | "UNSUPPORTED_SCHEME" | "NOT_FOUND";

/**
 * Raised when a DID cannot be resolved. The code lets the dispatcher decide
 * whether to fall back (NOT_FOUND maps to a soft miss elsewhere) or surface the
 * failure (INVALID_DID and UNSUPPORTED_SCHEME are hard errors).
 */
export class DidResolutionError extends Error {
  readonly code: DidResolutionCode;
  readonly did: string;

  constructor(message: string, code: DidResolutionCode, did: string) {
    super(message);
    this.name = "DidResolutionError";
    this.code = code;
    this.did = did;
  }
}

/** Ambient services handed to a resolver factory at resolution time. */
export interface ResolverContext {
  logger: Logger;
  config: MagnesiumConfig;
}

/**
 * A scheme resolver turns the addressable parts of a DID into a worker adapter.
 * Returning null is a soft miss (the worker is simply not known to this
 * resolver); throwing is a hard failure. Factories may be sync or async.
 */
export type AipResolver = (
  did: AipDid,
  ctx: ResolverContext,
) => WorkerAdapter | null | Promise<WorkerAdapter | null>;

/**
 * Resolves DIDs to WorkerAdapters. Resolvers are registered per scheme (the
 * method segment of a DID, e.g. "aip"), so future DID methods slot in without
 * touching dispatch logic. The registry is queried at dispatch time, so
 * registrations made after a dispatcher is constructed are visible (hot reload).
 */
export interface WorkerRegistry {
  /** Register or replace the resolver for a scheme. */
  register(scheme: string, resolver: AipResolver): void;
  /** Resolve a DID string to a worker, or null on a soft miss (NOT_FOUND-able). */
  resolve(did: string): Promise<WorkerAdapter | null>;
}

/**
 * In-memory WorkerRegistry. Currently only the "aip" scheme is wired, but the
 * scheme map keeps the resolution path method-agnostic.
 */
export class MemoryWorkerRegistry implements WorkerRegistry {
  private readonly resolvers = new Map<string, AipResolver>();

  constructor(private readonly ctx: ResolverContext) {}

  register(scheme: string, resolver: AipResolver): void {
    this.resolvers.set(scheme, resolver);
  }

  async resolve(did: string): Promise<WorkerAdapter | null> {
    const scheme = schemeOf(did);
    const resolver = this.resolvers.get(scheme);
    if (!resolver) {
      throw new DidResolutionError(
        `no resolver registered for DID scheme "${scheme}"`,
        "UNSUPPORTED_SCHEME",
        did,
      );
    }

    // Only the aip scheme has a structured parser today. The parse is the
    // INVALID_DID boundary; a malformed DID never reaches a resolver.
    const parsed = AipDidSchema.safeParse(did);
    if (!parsed.success) {
      throw new DidResolutionError(
        `malformed aip DID: ${parsed.error.issues[0]?.message ?? "invalid"}`,
        "INVALID_DID",
        did,
      );
    }

    const worker = await resolver(parsed.data, this.ctx);
    return worker;
  }
}

/**
 * Extract the scheme (method) from a DID string. "did:aip:..." yields "aip".
 * Anything that does not start with "did:" is treated as an empty/unknown scheme
 * so it routes to the UNSUPPORTED_SCHEME branch rather than crashing.
 */
function schemeOf(did: string): string {
  const parts = did.split(":");
  if (parts.length < 2 || parts[0] !== "did") return "";
  return parts[1];
}
