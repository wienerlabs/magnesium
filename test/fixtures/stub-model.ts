import type { ModelCallResult, ModelClient, StructuredRequest } from "../../src/models/types";
import { ZERO_USAGE } from "../../src/models/types";

/**
 * Deterministic ModelClient for tests. Responses are keyed by purpose and
 * validated through the request schema, so they exercise the same parsing path
 * as the real client without any network or API key.
 */
export class StubModelClient implements ModelClient {
  public readonly calls: { purpose: string; model: string }[] = [];

  constructor(private readonly responses: Record<string, unknown>) {}

  async structured<T>(req: StructuredRequest<T>): Promise<ModelCallResult<T>> {
    this.calls.push({ purpose: req.purpose, model: req.model });
    const raw = this.responses[req.purpose];
    if (raw === undefined) {
      throw new Error(`StubModelClient has no response for purpose "${req.purpose}"`);
    }
    const value = req.schema.parse(raw);
    return { value, usage: ZERO_USAGE, costUsd: 0, model: req.model };
  }
}
