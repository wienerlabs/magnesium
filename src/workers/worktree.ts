import { dirname, join } from "node:path";

import type { Logger } from "../logging/logger";
import { WorkerError } from "../util/errors";
import { execCommand } from "../util/exec";
import { ensureDir, rmrf } from "../util/fs";
import { shortId } from "../util/ids";

export interface Worktree {
  path: string;
  branch: string;
}

/**
 * Owns the target git repo and the per-task worktrees. Worktree paths are
 * derived deterministically from (runId, taskId) so a resume can locate and
 * discard a stale worktree and re-create it cleanly (amendment 2).
 */
export class WorkspaceManager {
  constructor(
    private readonly worktreesRoot: string,
    private readonly logger: Logger,
  ) {}

  private async git(cwd: string, args: string[], tolerateFailure = false) {
    const res = await execCommand("git", args, { cwd });
    if (res.code !== 0 && !tolerateFailure) {
      throw new WorkerError(`git ${args.join(" ")} failed: ${res.stderr.trim() || res.stdout.trim()}`);
    }
    return res;
  }

  /** Ensures workspaceDir is a git repo with at least one commit. Returns HEAD. */
  async ensureRepo(workspaceDir: string): Promise<string> {
    await ensureDir(workspaceDir);
    const inside = await execCommand("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: workspaceDir,
    });
    if (inside.code !== 0) {
      await this.git(workspaceDir, ["init", "-b", "main"]);
      await this.git(workspaceDir, ["config", "user.email", "magnesium@local"]);
      await this.git(workspaceDir, ["config", "user.name", "Magnesium"]);
    }
    const hasCommit = await execCommand("git", ["rev-parse", "--verify", "HEAD"], {
      cwd: workspaceDir,
    });
    if (hasCommit.code !== 0) {
      await execCommand("bash", ["-c", "echo 'magnesium workspace' > .magnesium-workspace"], {
        cwd: workspaceDir,
      });
      await this.git(workspaceDir, ["add", "-A"]);
      await this.git(workspaceDir, ["commit", "-m", "chore: initialize magnesium workspace"]);
    }
    return this.currentHead(workspaceDir);
  }

  async currentHead(workspaceDir: string): Promise<string> {
    const res = await this.git(workspaceDir, ["rev-parse", "HEAD"]);
    return res.stdout.trim();
  }

  /** Deterministic worktree path for a task. */
  worktreePathFor(runId: string, taskId: string): string {
    return join(this.worktreesRoot, runId, taskId);
  }

  branchFor(runId: string, taskId: string, slug: string): string {
    return `magnesium/${shortId(runId)}/${slug}-${shortId(taskId)}`;
  }

  /**
   * Creates a fresh worktree for a task. Idempotent: any existing worktree at
   * the deterministic path is removed first, so re-dispatch starts clean.
   */
  async createWorktree(
    workspaceDir: string,
    runId: string,
    taskId: string,
    slug: string,
    baseCommit: string,
  ): Promise<Worktree> {
    const path = this.worktreePathFor(runId, taskId);
    const branch = this.branchFor(runId, taskId, slug);
    await this.removeWorktree(workspaceDir, path);
    await ensureDir(dirname(path));
    await this.git(workspaceDir, ["worktree", "add", "-B", branch, path, baseCommit]);
    this.logger.debug({ taskId, path, branch }, "worktree created");
    return { path, branch };
  }

  /** Removes a worktree and its directory. Safe to call when none exists. */
  async removeWorktree(workspaceDir: string, path: string): Promise<void> {
    await execCommand("git", ["worktree", "remove", "--force", path], { cwd: workspaceDir });
    await rmrf(path);
    await execCommand("git", ["worktree", "prune"], { cwd: workspaceDir });
  }

  async listWorktreePaths(workspaceDir: string): Promise<string[]> {
    const res = await this.git(workspaceDir, ["worktree", "list", "--porcelain"]);
    const paths: string[] = [];
    for (const line of res.stdout.split("\n")) {
      if (line.startsWith("worktree ")) paths.push(line.slice("worktree ".length).trim());
    }
    return paths;
  }

  /**
   * Commits the worker's uncommitted changes onto the task branch. Workers do
   * not run git themselves; the orchestrator commits on their behalf so the
   * branch carries the result for integration. Returns the new commit sha, or
   * null when there was nothing to commit.
   */
  async commitWorktree(worktreePath: string, message: string): Promise<string | null> {
    await this.git(worktreePath, ["add", "-A"]);
    const status = await execCommand("git", ["status", "--porcelain"], { cwd: worktreePath });
    if (status.stdout.trim() === "") return null;
    await this.git(worktreePath, [
      "-c",
      "user.email=magnesium@local",
      "-c",
      "user.name=Magnesium",
      "commit",
      "-m",
      message,
    ]);
    return this.currentHead(worktreePath);
  }

  /** Resets the main checkout to a fresh integration branch off baseCommit. */
  async createIntegrationBranch(
    workspaceDir: string,
    branch: string,
    baseCommit: string,
  ): Promise<void> {
    await this.git(workspaceDir, ["checkout", "-B", branch, baseCommit]);
  }

  /** Merges a task branch into the current branch. Aborts cleanly on conflict. */
  async mergeBranch(
    workspaceDir: string,
    branch: string,
    message: string,
  ): Promise<{ ok: boolean; conflict: boolean }> {
    const res = await execCommand(
      "git",
      ["-c", "user.email=magnesium@local", "-c", "user.name=Magnesium", "merge", "--no-ff", "-m", message, branch],
      { cwd: workspaceDir },
    );
    if (res.code === 0) return { ok: true, conflict: false };
    await execCommand("git", ["merge", "--abort"], { cwd: workspaceDir });
    return { ok: false, conflict: true };
  }
}
