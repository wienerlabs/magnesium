import { execCommand } from "../util/exec";
import type { Verdict, Verifier, VerifyInput } from "./verifier";

/**
 * Runs the configured test command inside the task worktree. Pass is exit code
 * zero. The command runs as a host subprocess scoped to the worktree with a
 * timeout. (Phase 1 sandbox = process + worktree + timeout, not a VM jail.)
 */
export class CodeTestVerifier implements Verifier {
  constructor(
    private readonly testCommand: string,
    private readonly timeoutMs: number,
  ) {}

  async verify(input: VerifyInput): Promise<Verdict> {
    const res = await execCommand("bash", ["-lc", this.testCommand], {
      cwd: input.worktreePath,
      timeoutMs: this.timeoutMs,
    });
    const report = [`$ ${this.testCommand}`, res.stdout, res.stderr]
      .join("\n")
      .trim()
      .slice(0, 8_000);
    if (res.timedOut) {
      return { pass: false, reason: `test command timed out after ${this.timeoutMs}ms`, report };
    }
    if (res.code === 0) {
      return { pass: true, reason: "tests passed", report };
    }
    return { pass: false, reason: `tests failed (exit ${res.code})`, report };
  }
}
