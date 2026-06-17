import type { Verdict, Verifier, VerifyInput } from "./verifier";

/**
 * Sequential combinator: run a base verifier (for example CriticVerifier or the
 * CompositeVerifier), then run a policy verifier on the same input. A task
 * passes only when BOTH verifiers pass.
 *
 * Short-circuit on base failure: if the base verifier fails, its verdict is
 * returned unchanged and the policy verifier is NOT called. This is by design
 * to save the second critic call. A caller that needs both verdicts in every
 * case should not use this combinator.
 *
 * On a policy failure (base passed, policy did not), the policy verdict is
 * returned with its reason prefixed by "policy: " so the gate identity is clear
 * in the ledger and supervisor surfaces.
 *
 * Both branches preserve the inner verdict's usage and costUsd so the engine
 * records the corresponding llm_call. When the base passes, the returned usage
 * and cost belong to the policy call; when the base fails, they belong to the
 * base call. The engine records one llm_call per verify() return, so a passing
 * gate that ran both verifiers reflects only the policy call's cost in the
 * returned verdict. The base call's cost, when the base verifier itself is
 * model-backed, is the base verifier's own concern; this combinator does not
 * double count.
 */
export class PolicyGatedVerifier implements Verifier {
  constructor(
    private readonly base: Verifier,
    private readonly policy: Verifier,
  ) {}

  async verify(input: VerifyInput): Promise<Verdict> {
    const baseVerdict = await this.base.verify(input);
    if (!baseVerdict.pass) {
      return baseVerdict;
    }

    const policyVerdict = await this.policy.verify(input);
    if (!policyVerdict.pass) {
      return {
        ...policyVerdict,
        reason: `policy: ${policyVerdict.reason}`,
      };
    }

    return policyVerdict;
  }
}
