import { createServer, type Server } from "node:http";
import { type AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../../../src/config/load";
import { createLogger } from "../../../src/logging/logger";
import { parseAipDid } from "../../../src/workers/aip/aip-did";
import {
  HttpRemoteWorker,
  createHttpAipResolver,
  type FetchInit,
  type FetchResponse,
} from "../../../src/workers/aip/http-resolver";
import type { ResolverContext } from "../../../src/workers/aip/worker-registry";
import type { WorkerTask } from "../../../src/workers/worker";

const logger = createLogger({ level: "silent" });
const config = loadConfig();
const ctx: ResolverContext = { logger, config };

const AIP_DID = "did:aip:Wallet99:test-agent";

function makeTask(): WorkerTask {
  return {
    runId: "run123456",
    taskId: "task78901234",
    slug: "feature",
    title: "Build feature",
    description: "implement it",
    acceptanceCriteria: ["tests pass", "lint clean"],
    kind: "code",
    model: "claude-sonnet-4-6",
    worktreePath: "/tmp/unused",
  };
}

function jsonResponse(status: number, body: unknown): FetchResponse {
  const statusText = status === 200 ? "OK" : status === 404 ? "Not Found" : "Error";
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    json: async () => body,
  };
}

const VALID_WIRE = {
  ok: true,
  total_cost_usd: 0.42,
};

describe("HttpRemoteWorker dispatch", () => {
  it("dispatches a 2xx response and maps the WorkerResult from the body", async () => {
    const fetchStub = async (): Promise<FetchResponse> =>
      jsonResponse(200, { ok: true, total_cost_usd: 1.5, summary: "remote done" });
    const worker = new HttpRemoteWorker(parseAipDid(AIP_DID), { fetch: fetchStub });

    const result = await worker.dispatch(makeTask(), new AbortController().signal);
    expect(result.ok).toBe(true);
    expect(result.costUsd).toBe(1.5);
    expect(result.summary).toBe("remote done");
  });

  it("maps a non-2xx status (400, 404, 500) to an ok:false error with the status code", async () => {
    for (const status of [400, 404, 500]) {
      const worker = new HttpRemoteWorker(parseAipDid(AIP_DID), {
        fetch: async () => jsonResponse(status, { ok: true, total_cost_usd: 0 }),
      });
      const result = await worker.dispatch(makeTask(), new AbortController().signal);
      expect(result.ok).toBe(false);
      expect(result.costUsd).toBe(0);
      expect(result.error).toContain(String(status));
    }
  });

  it("maps a network error (fetch rejects) to an ok:false error with the message", async () => {
    const worker = new HttpRemoteWorker(parseAipDid(AIP_DID), {
      fetch: async () => {
        throw new Error("ECONNREFUSED 127.0.0.1:9");
      },
    });
    const result = await worker.dispatch(makeTask(), new AbortController().signal);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("network error");
    expect(result.error).toContain("ECONNREFUSED");
  });

  it("returns an ok:false error immediately when the signal is already aborted", async () => {
    let called = false;
    const worker = new HttpRemoteWorker(parseAipDid(AIP_DID), {
      fetch: async () => {
        called = true;
        return jsonResponse(200, VALID_WIRE);
      },
    });
    const controller = new AbortController();
    controller.abort();

    const result = await worker.dispatch(makeTask(), controller.signal);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("aborted before");
    expect(called).toBe(false);
  });

  it("propagates the abort signal into fetch and maps an AbortError to ok:false", async () => {
    const controller = new AbortController();
    const worker = new HttpRemoteWorker(parseAipDid(AIP_DID), {
      fetch: async (_url: string, init: FetchInit) => {
        expect(init.signal).toBe(controller.signal);
        controller.abort();
        const err = new DOMException("The operation was aborted.", "AbortError");
        throw err;
      },
    });

    const result = await worker.dispatch(makeTask(), controller.signal);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("aborted during");
  });

  it("maps a plain AbortError (timeout style) to an ok:false error", async () => {
    const worker = new HttpRemoteWorker(parseAipDid(AIP_DID), {
      fetch: async () => {
        const err = new Error("aborted");
        err.name = "AbortError";
        throw err;
      },
    });
    const result = await worker.dispatch(makeTask(), new AbortController().signal);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("aborted during");
  });

  it("serializes every task field and POSTs JSON", async () => {
    let captured: { url: string; init: FetchInit } | undefined;
    const worker = new HttpRemoteWorker(parseAipDid(AIP_DID), {
      fetch: async (url: string, init: FetchInit) => {
        captured = { url, init };
        return jsonResponse(200, VALID_WIRE);
      },
    });

    await worker.dispatch(makeTask(), new AbortController().signal);
    expect(captured).toBeDefined();
    expect(captured?.init.method).toBe("POST");
    expect(captured?.init.headers["content-type"]).toBe("application/json");

    const sent = JSON.parse(captured!.init.body) as Record<string, unknown>;
    expect(sent).toEqual({
      runId: "run123456",
      taskId: "task78901234",
      slug: "feature",
      title: "Build feature",
      description: "implement it",
      acceptanceCriteria: ["tests pass", "lint clean"],
      kind: "code",
      model: "claude-sonnet-4-6",
    });
  });

  it("fails validation when the response is missing total_cost_usd", async () => {
    const worker = new HttpRemoteWorker(parseAipDid(AIP_DID), {
      fetch: async () => jsonResponse(200, { ok: true, summary: "no cost" }),
    });
    const result = await worker.dispatch(makeTask(), new AbortController().signal);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("malformed result");
  });

  it("ignores extra fields not present in WorkerResult", async () => {
    const worker = new HttpRemoteWorker(parseAipDid(AIP_DID), {
      fetch: async () =>
        jsonResponse(200, { ok: true, total_cost_usd: 0.1, somethingExtra: "ignored" }),
    });
    const result = await worker.dispatch(makeTask(), new AbortController().signal);
    expect(result.ok).toBe(true);
    expect(result.costUsd).toBe(0.1);
    expect((result as unknown as Record<string, unknown>).somethingExtra).toBeUndefined();
  });

  it("maps optional fields (session_id, usage, num_turns, summary, error) into the result", async () => {
    const worker = new HttpRemoteWorker(parseAipDid(AIP_DID), {
      fetch: async () =>
        jsonResponse(200, {
          ok: false,
          total_cost_usd: 0.99,
          session_id: "sess-7",
          num_turns: 5,
          summary: "tried hard",
          error: "verification failed",
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            cache_read_input_tokens: 20,
            cache_creation_input_tokens: 10,
          },
        }),
    });

    const result = await worker.dispatch(makeTask(), new AbortController().signal);
    expect(result).toEqual({
      ok: false,
      costUsd: 0.99,
      sessionId: "sess-7",
      numTurns: 5,
      summary: "tried hard",
      error: "verification failed",
      usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 20, cacheCreationTokens: 10 },
    });
  });

  it("defaults missing usage subfields to zero", async () => {
    const worker = new HttpRemoteWorker(parseAipDid(AIP_DID), {
      fetch: async () =>
        jsonResponse(200, { ok: true, total_cost_usd: 0, usage: { input_tokens: 7 } }),
    });
    const result = await worker.dispatch(makeTask(), new AbortController().signal);
    expect(result.usage).toEqual({
      inputTokens: 7,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
  });

  it("constructs the URL as https://{wallet}/aip/{agentId}/dispatch", async () => {
    let seenUrl = "";
    const worker = new HttpRemoteWorker(parseAipDid("did:aip:WalletABC:my-agent"), {
      fetch: async (url: string) => {
        seenUrl = url;
        return jsonResponse(200, VALID_WIRE);
      },
    });
    await worker.dispatch(makeTask(), new AbortController().signal);
    expect(seenUrl).toBe("https://WalletABC/aip/my-agent/dispatch");
  });
});

describe("createHttpAipResolver", () => {
  it("returns an AipResolver that builds an HttpRemoteWorker using the injected fetch", async () => {
    const fetchStub = async (): Promise<FetchResponse> =>
      jsonResponse(200, { ok: true, total_cost_usd: 2.0, summary: "via resolver" });
    const resolver = createHttpAipResolver({ fetch: fetchStub });

    const worker = await resolver(parseAipDid(AIP_DID), ctx);
    expect(worker).toBeInstanceOf(HttpRemoteWorker);

    const result = await worker!.dispatch(makeTask(), new AbortController().signal);
    expect(result.ok).toBe(true);
    expect(result.costUsd).toBe(2.0);
    expect(result.summary).toBe("via resolver");
  });
});

describe("HttpRemoteWorker against a local node:http server", () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
  });

  function listen(srv: Server): Promise<number> {
    return new Promise((resolve) => {
      srv.listen(0, "127.0.0.1", () => {
        const addr = srv.address() as AddressInfo;
        resolve(addr.port);
      });
    });
  }

  it("POSTs to /aip/{agentId}/dispatch and round-trips a valid WorkerResult", async () => {
    let receivedPath = "";
    let receivedMethod = "";
    let receivedBody = "";
    server = createServer((req, res) => {
      receivedPath = req.url ?? "";
      receivedMethod = req.method ?? "";
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        receivedBody = Buffer.concat(chunks).toString("utf8");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ ok: true, total_cost_usd: 0.33, summary: "served locally" }),
        );
      });
    });
    const port = await listen(server);

    const did = parseAipDid(`did:aip:127:test-agent`);
    const worker = new HttpRemoteWorker(did, {
      scheme: "http",
      fetch: (_url: string, init: FetchInit) =>
        fetch(`http://127.0.0.1:${port}/aip/test-agent/dispatch`, init) as Promise<FetchResponse>,
    });

    const result = await worker.dispatch(makeTask(), new AbortController().signal);
    expect(result.ok).toBe(true);
    expect(result.costUsd).toBe(0.33);
    expect(result.summary).toBe("served locally");
    expect(receivedMethod).toBe("POST");
    expect(receivedPath).toBe("/aip/test-agent/dispatch");
    expect(JSON.parse(receivedBody).taskId).toBe("task78901234");
  });
});
