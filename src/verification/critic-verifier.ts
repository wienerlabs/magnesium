import type { MagnesiumConfig } from "../config/schema";
import { CriticVerdictSchema } from "../models/schemas";
import type { ModelClient } from "../models/types";
import type { Verdict, Verifier, VerifyInput } from "./verifier";

const SYSTEM = [
  "You are a strict critic. You judge whether a worker's result satisfies a",
  "task's acceptance criteria. Be skeptical. Only pass when every criterion is",
  "clearly met. Return your verdict via the provided tool.",
].join(" ");

/**
 * LLM-judge verifier for generic and research tasks. Returns a structured
 * verdict scored against the task's acceptance criteria.
 */
export class CriticVerifier implements Verifier {
  constructor(
    private readonly client: ModelClient,
    private readonly config: MagnesiumConfig,
  ) {}

  async verify(input: VerifyInput): Promise<Verdict> {
    const user = [
      `Task: ${input.title}`,
      "",
      input.description,
      "",
      "Acceptance criteria:",
      ...input.acceptanceCriteria.map((c) => `- ${c}`),
      "",
      "Worker result summary:",
      input.workerSummary ?? "(no summary provided)",
    ].join("\n");

    const { value } = await this.client.structured({
      purpose: "critic",
      model: this.config.models.critic,
      system: SYSTEM,
      user,
      schema: CriticVerdictSchema,
      schemaName: "critic_verdict",
      schemaDescription: "Whether the result satisfies the acceptance criteria",
    });

    return {
      pass: value.pass,
      reason: value.reasons.join("; "),
      report: `confidence=${value.confidence}`,
    };
  }
}
