import type { Verdict, Verifier, VerifyInput } from "./verifier";

/** Routes code tasks to the test verifier and everything else to the critic. */
export class CompositeVerifier implements Verifier {
  constructor(
    private readonly codeVerifier: Verifier,
    private readonly criticVerifier: Verifier,
  ) {}

  verify(input: VerifyInput): Promise<Verdict> {
    if (input.kind === "code") return this.codeVerifier.verify(input);
    return this.criticVerifier.verify(input);
  }
}
