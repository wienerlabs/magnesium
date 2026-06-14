import { spawn } from "node:child_process";

export interface ExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Called for every complete line written to stdout (newline-delimited). */
  onStdoutLine?: (line: string) => void;
  /** Signal used to terminate the process on timeout or abort. */
  killSignal?: NodeJS.Signals;
}

export interface ExecResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
}

/**
 * Spawns a command, captures stdout/stderr, and enforces a timeout. The process
 * is terminated with killSignal (default SIGTERM) on timeout or AbortSignal,
 * which is how the supervisor stops in-flight workers when the budget trips.
 */
export function execCommand(
  command: string,
  args: string[],
  opts: ExecOptions = {},
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const killSignal = opts.killSignal ?? "SIGTERM";
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let stdoutBuffer = "";
    let timedOut = false;
    let aborted = false;
    let settled = false;

    const timer =
      opts.timeoutMs && opts.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            child.kill(killSignal);
          }, opts.timeoutMs)
        : undefined;

    const onAbort = () => {
      aborted = true;
      child.kill(killSignal);
    };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    };

    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stdout += text;
      if (opts.onStdoutLine) {
        stdoutBuffer += text;
        let idx: number;
        while ((idx = stdoutBuffer.indexOf("\n")) >= 0) {
          const line = stdoutBuffer.slice(0, idx);
          stdoutBuffer = stdoutBuffer.slice(idx + 1);
          if (line.trim().length > 0) opts.onStdoutLine(line);
        }
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });

    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (opts.onStdoutLine && stdoutBuffer.trim().length > 0) {
        opts.onStdoutLine(stdoutBuffer);
      }
      resolve({ code, signal, stdout, stderr, timedOut, aborted });
    });
  });
}
