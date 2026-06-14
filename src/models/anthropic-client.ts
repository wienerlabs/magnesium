import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

import type { PriceRate } from "../config/schema";
import { defaultBackoff, withBackoff } from "../util/backoff";
import { computeCostUsd } from "./cost";
import type { ModelCallResult, ModelClient, StructuredRequest, TokenUsage } from "./types";

export interface AnthropicModelClientOptions {
  apiKey: string;
  pricing: Record<string, PriceRate>;
  defaultMaxTokens?: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapUsage(u: any): TokenUsage {
  return {
    inputTokens: u?.input_tokens ?? 0,
    outputTokens: u?.output_tokens ?? 0,
    cacheReadTokens: u?.cache_read_input_tokens ?? 0,
    cacheCreationTokens: u?.cache_creation_input_tokens ?? 0,
  };
}

function isRetryable(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  return (
    status === 408 ||
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 529
  );
}

function extractJsonObject(text: string): unknown {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fence ? fence[1] : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return JSON.parse(candidate.slice(start, end + 1));
  }
  throw new Error("model returned neither a tool_use block nor parseable JSON");
}

/**
 * The production ModelClient. Wraps the Anthropic Messages API with structured
 * output (a forced tool call, or an auto tool call when extended thinking is on)
 * and zod validation. Retries transient errors with backoff.
 */
export class AnthropicModelClient implements ModelClient {
  private readonly client: Anthropic;
  private readonly pricing: Record<string, PriceRate>;
  private readonly defaultMaxTokens: number;

  constructor(opts: AnthropicModelClientOptions) {
    this.client = new Anthropic({ apiKey: opts.apiKey });
    this.pricing = opts.pricing;
    this.defaultMaxTokens = opts.defaultMaxTokens ?? 4096;
  }

  async structured<T>(req: StructuredRequest<T>): Promise<ModelCallResult<T>> {
    const jsonSchema = z.toJSONSchema(req.schema) as Record<string, unknown>;
    delete jsonSchema.$schema;

    const tool = {
      name: req.schemaName,
      description: req.schemaDescription ?? `Return a ${req.schemaName} object`,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      input_schema: jsonSchema as any,
    };

    const thinkingEnabled = req.thinkingTokens !== undefined && req.thinkingTokens > 0;
    const maxTokens =
      (req.maxTokens ?? this.defaultMaxTokens) + (thinkingEnabled ? req.thinkingTokens! : 0);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body: any = {
      model: req.model,
      max_tokens: maxTokens,
      system: req.system,
      messages: [{ role: "user", content: req.user }],
      tools: [tool],
      // Extended thinking is incompatible with a forced tool_choice, so when
      // thinking is enabled we use auto and rely on the prompt to elicit the
      // tool call, with a text-JSON fallback.
      tool_choice: thinkingEnabled
        ? { type: "auto" }
        : { type: "tool", name: req.schemaName },
    };
    if (thinkingEnabled) {
      body.thinking = { type: "enabled", budget_tokens: req.thinkingTokens };
    }

    const message = await withBackoff(
      () => this.client.messages.create(body),
      isRetryable,
      defaultBackoff,
    );

    const usage = mapUsage((message as { usage?: unknown }).usage);
    const costUsd = computeCostUsd(req.model, usage, this.pricing);
    const value = this.extract(req, message);
    return { value, usage, costUsd, model: req.model, raw: message };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private extract<T>(req: StructuredRequest<T>, message: any): T {
    const content: unknown[] = message?.content ?? [];
    const toolUse = content.find(
      (b): b is { type: string; name: string; input: unknown } =>
        typeof b === "object" &&
        b !== null &&
        (b as { type?: string }).type === "tool_use" &&
        (b as { name?: string }).name === req.schemaName,
    );
    if (toolUse) {
      return req.schema.parse(toolUse.input);
    }
    const text = content
      .filter(
        (b): b is { type: string; text: string } =>
          typeof b === "object" && b !== null && (b as { type?: string }).type === "text",
      )
      .map((b) => b.text)
      .join("\n");
    return req.schema.parse(extractJsonObject(text));
  }
}
