import type { z } from "zod";

import type { LlmPurpose } from "../ledger/types";

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export interface ModelCallResult<T> {
  value: T;
  usage: TokenUsage;
  costUsd: number;
  model: string;
  raw?: unknown;
}

export interface StructuredRequest<T> {
  purpose: LlmPurpose;
  model: string;
  system: string;
  user: string;
  schema: z.ZodType<T>;
  schemaName: string;
  schemaDescription?: string;
  /** When set, enables extended thinking with this token budget. */
  thinkingTokens?: number;
  maxTokens?: number;
}

/**
 * The model boundary. Everything that needs structured reasoning depends on this
 * interface, not on the Anthropic SDK directly, so tests inject a deterministic
 * stub and no network or API key is required to exercise orchestration logic.
 */
export interface ModelClient {
  structured<T>(req: StructuredRequest<T>): Promise<ModelCallResult<T>>;
}

export const ZERO_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
};
