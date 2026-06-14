// Public surface for the AIP distributed worker dispatch seam. The integrator
// re-exports these from src/index.ts (see integration notes); keeping a local
// barrel means callers import one path regardless of internal file layout.
export {
  AIP_DID_REGEX,
  AipDidSchema,
  parseAipDid,
  formatAipDid,
  type AipDid,
} from "./aip-did";
export {
  DidResolutionError,
  MemoryWorkerRegistry,
  type WorkerRegistry,
  type AipResolver,
  type ResolverContext,
  type DidResolutionCode,
} from "./worker-registry";
export {
  AipDispatcher,
  LoopbackWorker,
  type AipDispatcherOptions,
} from "./aip-dispatcher";
