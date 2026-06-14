import { describe, expect, it } from "vitest";

import { loadConfig } from "../../../src/config/load";
import { createLogger } from "../../../src/logging/logger";
import type { WorkerAdapter, WorkerResult, WorkerTask } from "../../../src/workers/worker";
import {
  DidResolutionError,
  MemoryWorkerRegistry,
  type ResolverContext,
} from "../../../src/workers/aip/worker-registry";

const logger = createLogger({ level: "silent" });
const config = loadConfig();
const ctx: ResolverContext = { logger, config };

class MarkerWorker implements WorkerAdapter {
  constructor(public readonly mark: string) {}
  async dispatch(_task: WorkerTask, _signal: AbortSignal): Promise<WorkerResult> {
    return { ok: true, costUsd: 0, summary: this.mark };
  }
}

const AIP_DID = "did:aip:Wallet99:code-worker";

describe("MemoryWorkerRegistry", () => {
  it("resolves an aip DID to a registered worker adapter", async () => {
    const registry = new MemoryWorkerRegistry(ctx);
    const worker = new MarkerWorker("remote");
    registry.register("aip", (did) => (did.agentId === "code-worker" ? worker : null));

    const resolved = await registry.resolve(AIP_DID);
    expect(resolved).toBe(worker);
  });

  it("returns null (soft miss) when the resolver does not recognize the DID", async () => {
    const registry = new MemoryWorkerRegistry(ctx);
    registry.register("aip", () => null);
    const resolved = await registry.resolve(AIP_DID);
    expect(resolved).toBeNull();
  });

  it("throws DidResolutionError with code INVALID_DID when the DID is malformed", async () => {
    const registry = new MemoryWorkerRegistry(ctx);
    registry.register("aip", () => new MarkerWorker("x"));
    // "did:aip:..." scheme is known, but the body is not a valid aip DID.
    await expect(registry.resolve("did:aip:Bad_Wallet:Agent")).rejects.toMatchObject({
      name: "DidResolutionError",
      code: "INVALID_DID",
    });
  });

  it("throws DidResolutionError with code UNSUPPORTED_SCHEME for an unknown scheme", async () => {
    const registry = new MemoryWorkerRegistry(ctx);
    registry.register("aip", () => new MarkerWorker("x"));
    await expect(registry.resolve("did:web:Wallet99:agent")).rejects.toMatchObject({
      code: "UNSUPPORTED_SCHEME",
    });
    // Also covers a string with no scheme at all.
    await expect(registry.resolve("garbage")).rejects.toBeInstanceOf(DidResolutionError);
  });

  it("allows registering multiple resolvers for different schemes", async () => {
    const registry = new MemoryWorkerRegistry(ctx);
    const aipWorker = new MarkerWorker("aip");
    registry.register("aip", () => aipWorker);
    // A second scheme can be registered; aip resolution is unaffected.
    registry.register("web", () => new MarkerWorker("web"));

    const resolved = await registry.resolve(AIP_DID);
    expect(resolved).toBe(aipWorker);
  });

  it("passes context (logger, config) to resolver factories", async () => {
    const registry = new MemoryWorkerRegistry(ctx);
    let seen: ResolverContext | undefined;
    registry.register("aip", (_did, factoryCtx) => {
      seen = factoryCtx;
      return new MarkerWorker("ctx");
    });

    await registry.resolve(AIP_DID);
    expect(seen).toBeDefined();
    expect(seen?.logger).toBe(logger);
    expect(seen?.config).toBe(config);
  });

  it("supports sync resolver factories that return a WorkerAdapter immediately", async () => {
    const registry = new MemoryWorkerRegistry(ctx);
    const worker = new MarkerWorker("sync");
    // Factory returns a plain WorkerAdapter (not a Promise).
    registry.register("aip", () => worker);
    const resolved = await registry.resolve(AIP_DID);
    expect(resolved).toBe(worker);
  });

  it("supports async resolver factories that resolve to a WorkerAdapter", async () => {
    const registry = new MemoryWorkerRegistry(ctx);
    const worker = new MarkerWorker("async");
    registry.register("aip", async () => {
      await Promise.resolve();
      return worker;
    });
    const resolved = await registry.resolve(AIP_DID);
    expect(resolved).toBe(worker);
  });

  it("re-registering a scheme replaces the prior resolver", async () => {
    const registry = new MemoryWorkerRegistry(ctx);
    registry.register("aip", () => new MarkerWorker("first"));
    registry.register("aip", () => new MarkerWorker("second"));
    const resolved = await registry.resolve(AIP_DID);
    expect((resolved as MarkerWorker).mark).toBe("second");
  });
});
